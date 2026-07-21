import { expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSavedWorkflows,
  findWorkflowRunById,
  findLatestCompletedWorkflowRun,
  isValidWorkflowName,
  resolveSavedWorkflow,
  saveWorkflow,
} from "../src/workflow/saved.js";
import { encodeCwd } from "../src/store/run-store.js";
import { parseWorkflowScript } from "../src/workflow/parser.js";
import { executeWorkflowBody } from "../src/workflow/vm.js";

function scopes(): { root: string; projectDir: string; userDir: string } {
  const root = mkdtempSync(join(tmpdir(), "saved-"));
  const projectDir = join(root, "project", ".pi", "workflows");
  const userDir = join(root, "user");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  return { root, projectDir, userDir };
}

test("discovers from both scopes and project wins name conflicts", () => {
  const { projectDir, userDir } = scopes();
  writeFileSync(join(userDir, "audit-routes.js"), "// user");
  writeFileSync(join(userDir, "user-only.js"), "// user only");
  writeFileSync(join(projectDir, "audit-routes.js"), "// project");
  writeFileSync(join(projectDir, "Invalid Name.js"), "// ignored");

  const found = discoverSavedWorkflows("/unused", { projectDir, userDir });
  expect([...found.keys()].sort()).toEqual(["audit-routes", "user-only"]);
  expect(found.get("audit-routes")?.scope).toBe("project");
  expect(found.get("user-only")?.scope).toBe("user");
});

test("resolveSavedWorkflow returns the winning scope entry", () => {
  const { projectDir, userDir } = scopes();
  writeFileSync(join(userDir, "flow.js"), "// user");
  writeFileSync(join(projectDir, "flow.js"), "// project");
  const resolved = resolveSavedWorkflow("flow", "/unused", { projectDir, userDir });
  expect(resolved?.scope).toBe("project");
  expect(readFileSync(resolved!.path, "utf8")).toBe("// project");
  expect(resolveSavedWorkflow("missing", "/unused", { projectDir, userDir })).toBeUndefined();
});

test("saveWorkflow atomically publishes the complete script and provenance", () => {
  const { projectDir, userDir } = scopes();
  const script = "export const meta = { name: 'flow', description: 'x' };\nconst message = 'héllo 🌍';\nreturn message;\n";
  const path = saveWorkflow(
    { name: "flow", scope: "user", cwd: "/unused", script, provenance: { runId: "workflow-abc", date: "2026-07-11T00:00:00Z", args: { value: 1 } } },
    { projectDir, userDir },
  );
  expect(readFileSync(path, "utf8")).toBe([
    "// Saved workflow (pi-subagent-workflow)",
    "// runId: workflow-abc",
    "// saved: 2026-07-11T00:00:00Z",
    "// args: {\"value\":1}",
    "",
    script,
  ].join("\n"));
});

test("saveWorkflow leaves the target intact when its staging name collides", () => {
  const { projectDir, userDir } = scopes();
  const path = join(userDir, "flow.js");
  const previous = "existing workflow\n";
  const collision = "unrelated staging content\n";
  const uuid = "00000000-0000-4000-8000-000000000000";
  const temporary = `${path}.tmp-${process.pid}-${uuid}`;
  writeFileSync(path, previous);
  writeFileSync(temporary, collision);
  const randomUUID = spyOn(crypto, "randomUUID").mockReturnValueOnce(uuid);

  try {
    expect(() => saveWorkflow(
      { name: "flow", scope: "user", cwd: "/unused", script: "return 'new';", provenance: { runId: "workflow-new", date: "2026-07-11T00:00:00Z", args: null } },
      { projectDir, userDir },
    )).toThrow();
  } finally {
    randomUUID.mockRestore();
  }

  expect(readFileSync(path, "utf8")).toBe(previous);
  expect(readFileSync(temporary, "utf8")).toBe(collision);
});

test("saveWorkflow preserves the exact mode of an existing target", () => {
  const { projectDir, userDir } = scopes();
  const path = join(userDir, "flow.js");
  writeFileSync(path, "existing workflow\n");
  chmodSync(path, 0o666);

  saveWorkflow(
    { name: "flow", scope: "user", cwd: "/unused", script: "return 'new';", provenance: { runId: "workflow-new", date: "2026-07-11T00:00:00Z", args: null } },
    { projectDir, userDir },
  );

  expect(statSync(path).mode & 0o777).toBe(0o666);
});

test("saved provenance escapes JavaScript line separators in args", async () => {
  const { projectDir, userDir } = scopes();
  const script = "export const meta = { name: 'safe-flow', description: 'x' };\nreturn 1;\n";
  const injected = "\u2028log('INJECTED')\u2028//";
  const path = saveWorkflow({
    name: "safe-flow",
    scope: "project",
    cwd: "/unused",
    script,
    provenance: { runId: "workflow-safe-1", date: "2026-07-11T00:00:00Z", args: injected },
  }, { projectDir, userDir });

  const written = readFileSync(path, "utf8");
  expect(written).toContain("\\u2028log('INJECTED')\\u2028//");
  expect(written).not.toContain(injected);
  let logged = false;
  const parsed = parseWorkflowScript(written);
  expect(await executeWorkflowBody(parsed.body, parsed.meta.name, {
    args: null,
    agent: async () => null,
    phase: () => {},
    log: () => { logged = true; },
  })).toBe(1);
  expect(logged).toBe(false);
});

test("saveWorkflow rejects a non-kebab-case name", () => {
  const { projectDir, userDir } = scopes();
  expect(() => saveWorkflow({ name: "../escape", scope: "project", cwd: "/unused", script: "x", provenance: { runId: "r", date: "d", args: null } }, { projectDir, userDir })).toThrow();
});

test("isValidWorkflowName guards traversal and casing", () => {
  expect(isValidWorkflowName("audit-routes")).toBe(true);
  expect(isValidWorkflowName("Audit")).toBe(false);
  expect(isValidWorkflowName("../x")).toBe(false);
  expect(isValidWorkflowName("a/b")).toBe(false);
});

test("findLatestCompletedWorkflowRun picks the newest completed workflow run for the cwd", () => {
  const { root } = scopes();
  const runsRoot = join(root, "runs");
  const cwd = "/work/proj";
  const base = join(runsRoot, encodeCwd(cwd));

  const makeRun = (runId: string, createdAt: string, status: string, kind = "workflow"): void => {
    const dir = join(base, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify({ runId, kind, createdAt }));
    writeFileSync(join(dir, "status.json"), JSON.stringify({ status }));
    writeFileSync(join(dir, "script.js"), `export const meta = { name: '${runId}', description: 'x' };`);
    writeFileSync(join(dir, "args.json"), JSON.stringify({ id: runId }));
  };
  makeRun("workflow-old-1", "2026-07-01T00:00:00Z", "completed");
  makeRun("workflow-new-1", "2026-07-10T00:00:00Z", "completed");
  makeRun("workflow-failed-1", "2026-07-11T00:00:00Z", "failed");
  makeRun("run-newest-1", "2026-07-12T00:00:00Z", "completed", "subagent");

  const latest = findLatestCompletedWorkflowRun(cwd, runsRoot);
  expect(latest?.runId).toBe("workflow-new-1");
  expect(latest?.args).toEqual({ id: "workflow-new-1" });
  expect(findLatestCompletedWorkflowRun("/nonexistent", runsRoot)).toBeUndefined();
});

test("findWorkflowRunById accepts valid ids and rejects traversal ids", () => {
  const { root } = scopes();
  const runsRoot = join(root, "runs");
  const cwd = "/work/proj";
  const runId = "workflow-valid-1";
  const runDir = join(runsRoot, encodeCwd(cwd), runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId, kind: "workflow", createdAt: "2026-07-11T00:00:00Z" }));
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ status: "completed" }));
  writeFileSync(join(runDir, "script.js"), "return 1;");

  expect(findWorkflowRunById(cwd, runId, runsRoot)?.runDir).toBe(runDir);
  expect(findWorkflowRunById(cwd, "../workflow-escape-1", runsRoot)).toBeUndefined();
  expect(findWorkflowRunById(cwd, "/tmp/workflow-escape-1", runsRoot)).toBeUndefined();

  writeFileSync(join(runDir, "status.json"), JSON.stringify({ status: "failed" }));
  expect(findWorkflowRunById(cwd, runId, runsRoot)).toBeUndefined();
});

test("completed workflow lookup refuses a generation.pending run", () => {
  const { root } = scopes();
  const runsRoot = join(root, "runs");
  const cwd = "/work/proj";
  const runId = "workflow-quarantined-1";
  const runDir = join(runsRoot, encodeCwd(cwd), runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId, kind: "workflow", createdAt: "2026-07-11T00:00:00Z" }));
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ status: "completed" }));
  writeFileSync(join(runDir, "script.js"), "return 1;");
  writeFileSync(join(runDir, "generation.pending"), JSON.stringify({ v: 1 }));

  expect(findWorkflowRunById(cwd, runId, runsRoot)).toBeUndefined();
  expect(findLatestCompletedWorkflowRun(cwd, runsRoot)).toBeUndefined();
});
