import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { encodeCwd } from "../src/store/run-store.js";
import { registerSavedWorkflowCommands, type SavedCommandServices } from "../src/workflow/commands.js";
import { userWorkflowsDir } from "../src/workflow/saved.js";

/**
 * Session-switch discovery: extensions reload per session switch, so each
 * `registerSavedWorkflowCommands` call plus a `session_start` emit models one
 * session. The commands a session exposes must follow that session's cwd, never
 * the process launch cwd, while user-scope workflows stay available everywhere.
 */

const services: SavedCommandServices = {
  consent: {} as SavedCommandServices["consent"],
  approve: (async () => {}) as SavedCommandServices["approve"],
  approvalPolicy: () => "auto",
  selfPath: "/self.ts",
};

interface FakePi {
  pi: ExtensionAPI;
  commands: string[];
  start(cwd: string): Promise<void>;
}

/** A fresh fake host, standing in for the fresh extension instance a switch reloads. */
function fakeSession(): FakePi {
  const commands: string[] = [];
  const startHandlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
  const pi = {
    registerCommand: (name: string) => { commands.push(name); },
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      if (event === "session_start") startHandlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    commands,
    async start(cwd: string) {
      for (const handler of startHandlers) await handler({ type: "session_start" }, { cwd } as ExtensionContext);
    },
  };
}

function makeProject(root: string, name: string, workflow: string): string {
  const cwd = join(root, name);
  const dir = join(cwd, ".pi", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${workflow}.js`), `export const meta = { name: '${workflow}', description: 'x' };\nreturn 1;\n`);
  return cwd;
}

let root: string;
let originalAgentDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saved-cmd-"));
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  mkdirSync(userWorkflowsDir(), { recursive: true });
  writeFileSync(join(userWorkflowsDir(), "shared-flow.js"), "export const meta = { name: 'shared-flow', description: 'x' };\nreturn 1;\n");
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

test("session commands follow the effective session cwd, not the launch cwd", async () => {
  const projectA = makeProject(root, "project-a", "alpha-flow");
  const projectB = makeProject(root, "project-b", "beta-flow");

  // Session launched in project A.
  const a = fakeSession();
  registerSavedWorkflowCommands(a.pi, services);
  await a.start(projectA);
  expect(a.commands).toContain("wf-alpha-flow");
  expect(a.commands).toContain("wf-shared-flow"); // user scope, always available
  expect(a.commands).not.toContain("wf-beta-flow");

  // Cross-project switch: pi reloads the extension, so a fresh instance runs
  // session_start with project B's cwd. Project A's project-scope command must
  // not leak into project B.
  const b = fakeSession();
  registerSavedWorkflowCommands(b.pi, services);
  await b.start(projectB);
  expect(b.commands).toContain("wf-beta-flow");
  expect(b.commands).toContain("wf-shared-flow");
  expect(b.commands).not.toContain("wf-alpha-flow");
});

test("workflow-save registers before any session_start", () => {
  const s = fakeSession();
  registerSavedWorkflowCommands(s.pi, services);
  expect(s.commands).toEqual(["workflow-save"]);
});

test("a runtime command-registration failure advertises the immediately working tool fallback", async () => {
  const cwd = join(root, "project-fallback");
  const runId = "workflow-fallback-1";
  const runDir = join(process.env.PI_CODING_AGENT_DIR!, "subagent-workflow", "runs", encodeCwd(cwd), runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    v: 2,
    runId,
    kind: "workflow",
    createdAt: "2026-07-13T00:00:00.000Z",
    children: [],
  }));
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ status: "completed", children: {} }));
  writeFileSync(join(runDir, "events.jsonl"), "");
  writeFileSync(join(runDir, "script.js"), "export const meta = { name: 'fallback-flow', description: 'x' };\nreturn 1;\n");
  writeFileSync(join(runDir, "args.json"), "null\n");

  const pi = {
    on: () => {},
    registerCommand: (name: string) => {
      if (name.startsWith("wf-")) throw new Error("runtime registration unsupported");
    },
  } as unknown as ExtensionAPI;
  const saveRun = registerSavedWorkflowCommands(pi, services);
  const notices: string[] = [];
  const ctx = {
    cwd,
    ui: {
      select: async () => "Project (.pi/workflows)",
      notify: (message: string) => { notices.push(message); },
    },
  } as unknown as ExtensionCommandContext;

  await saveRun(runId, ctx);

  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('workflow tool using script: "@fallback-flow"');
  expect(notices[0]).toContain("/wf-fallback-flow will be available next session");
  expect(notices[0]).not.toContain("Run it with /wf-fallback-flow");
});
