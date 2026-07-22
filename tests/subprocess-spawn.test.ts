import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import childShim from "../extensions/child-shim.js";
import type { ParentContext } from "../src/runner/child.js";
import { preflightSubprocessChild, spawnSubprocessChild, resolveShimPath, resolveChildPiEntry } from "../src/runner/subprocess/spawn-child.js";
import type { ChildRpc, RpcExit } from "../src/runner/subprocess/rpc-transport.js";
import { readToolReport, SHIM_SPEC_ENV, writeToolReport } from "../src/runner/subprocess/shim-contract.js";
import type { SubagentSpec } from "../src/types.js";

const tempDirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "subprocess-spawn-test-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env[SHIM_SPEC_ENV];
});

function fakeParent(cwd: string): ParentContext {
  const model = { provider: "openai-codex", id: "gpt-5.6-terra" };
  const selfPath = join(cwd, "subagent-workflow.ts");
  writeFileSync(resolveShimPath(selfPath), "// readable child shim fixture\n");
  return {
    ctx: {
      cwd,
      model,
      modelRegistry: { find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined), getAll: () => [model] },
    } as unknown as ExtensionContext,
    thinkingLevel: "high",
    selfPath,
  };
}

interface FakeRpcControls {
  rpc: ChildRpc;
  sent: Array<Record<string, unknown>>;
  rawSent: Array<Record<string, unknown>>;
  killed: NodeJS.Signals[];
  emit: (event: Record<string, unknown>) => void;
  spawnedCommands: string[][];
  spawnedEnvs: Array<NodeJS.ProcessEnv | undefined>;
}

function fakeSpawn(options: { onSpawn?: (env: NodeJS.ProcessEnv | undefined) => void; respond?: Record<string, unknown> }): FakeRpcControls {
  const eventListeners = new Set<(event: Record<string, unknown>) => void>();
  const controls: FakeRpcControls = {
    sent: [],
    rawSent: [],
    killed: [],
    spawnedCommands: [],
    spawnedEnvs: [],
    emit: (event) => { for (const listener of eventListeners) listener(event); },
    rpc: undefined as unknown as ChildRpc,
  };
  // Like a real process, kill() ends the fake: construction-failure paths
  // await rpc.exited after SIGKILL and must not hang on the fake.
  let resolveExited: (exit: RpcExit) => void;
  const exited = new Promise<RpcExit>((resolve) => { resolveExited = resolve; });
  controls.rpc = {
    request: (command) => {
      controls.sent.push(command);
      const type = command.type as string;
      if (options.respond && type in options.respond) return Promise.resolve(options.respond[type]);
      if (type === "get_state") return Promise.resolve({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      return Promise.resolve(undefined);
    },
    send: (message) => { controls.rawSent.push(message); },
    onEvent: (listener) => { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    onExit: () => () => {},
    kill: (signal = "SIGKILL") => {
      controls.killed.push(signal);
      resolveExited({ code: null, signal });
    },
    exited,
    stderrTail: () => "",
  };
  return controls;
}

const spawnFor = (controls: FakeRpcControls) =>
  (command: readonly string[], spawnOptions: { cwd: string; env?: NodeJS.ProcessEnv }): ChildRpc => {
    controls.spawnedCommands.push([...command]);
    controls.spawnedEnvs.push(spawnOptions.env);
    // Stand in for the shim: publish the tool report the child would write.
    const specPath = spawnOptions.env?.[SHIM_SPEC_ENV];
    if (specPath) {
      const spec = JSON.parse(readFileSync(specPath, "utf8")) as { toolReportPath: string };
      writeToolReport(spec.toolReportPath, { activeTools: ["read", "bash", "report_result"] });
    }
    return controls.rpc;
  };

describe("spawnSubprocessChild", () => {
  test("spawns pi rpc with the mapped flags and returns the reported toolset", async () => {
    const runDir = tempDir();
    const sessionsDir = join(runDir, "sessions");
    const controls = fakeSpawn({ respond: { get_state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionFile: join(sessionsDir, "child.jsonl") } } });
    const spec: SubagentSpec = { prompt: "audit the code", tools: ["read", "bash"] };
    const parent = fakeParent(runDir);
    const child = await spawnSubprocessChild(spec, parent, { sessionsDir }, spawnFor(controls));

    const command = controls.spawnedCommands[0]!;
    expect(command[0]).toBe(process.execPath);
    expect(command[1]).toBe(resolveChildPiEntry());
    expect(command).toContain("--session-dir");
    expect(command).toContain("--extension");
    expect(command).toContain(resolveShimPath(parent.selfPath));
    expect(controls.spawnedEnvs[0]?.[SHIM_SPEC_ENV]).toContain(join(runDir, "shim"));
    expect(child.resolved.tools).toEqual(["read", "bash", "report_result"]);
    expect(child.session.sessionFile).toBe(join(sessionsDir, "child.jsonl"));
  });

  test("rejects an unusable cwd before writing shim files or spawning", async () => {
    const runDir = tempDir();
    const missingCwd = join(runDir, "missing-cwd");
    const controls = fakeSpawn({});

    await expect(spawnSubprocessChild(
      { prompt: "task", cwd: missingCwd },
      fakeParent(runDir),
      { sessionsDir: join(runDir, "sessions") },
      spawnFor(controls),
    )).rejects.toThrow("not usable as a spawn cwd");

    expect(controls.spawnedCommands).toEqual([]);
    expect(existsSync(join(runDir, "shim"))).toBe(false);
  });

  test("preflight rejects missing and non-file launch artifacts", () => {
    const runDir = tempDir();
    const parent = fakeParent(runDir);
    const readable = join(runDir, "readable.js");
    const missing = join(runDir, "missing.js");
    const directory = join(runDir, "artifact-directory");
    writeFileSync(readable, "// fixture\n");
    mkdirSync(directory);

    expect(() => preflightSubprocessChild({ prompt: "task" }, parent, {
      childPiEntry: missing,
      shimPath: readable,
    })).toThrow("Child pi CLI entry");
    expect(() => preflightSubprocessChild({ prompt: "task" }, parent, {
      childPiEntry: readable,
      shimPath: missing,
    })).toThrow("Child shim");
    expect(() => preflightSubprocessChild({ prompt: "task" }, parent, {
      childPiEntry: readable,
      shimPath: directory,
    })).toThrow("not a regular file");
  });

  test("preflight validates fork session artifacts without writing files", () => {
    const runDir = tempDir();
    const parent = fakeParent(runDir);
    const childPiEntry = join(runDir, "cli.js");
    const forkSessionFile = join(runDir, "source.jsonl");
    writeFileSync(childPiEntry, "// fixture\n");
    writeFileSync(forkSessionFile, "transcript\n");

    const result = preflightSubprocessChild({ prompt: "task" }, parent, { childPiEntry, forkSessionFile });
    expect(result.childPiEntry).toBe(childPiEntry);
    expect(() => preflightSubprocessChild({ prompt: "task" }, parent, {
      childPiEntry,
      forkSessionFile: join(runDir, "missing.jsonl"),
    })).toThrow("Fork session file");
    expect(existsSync(join(runDir, "shim"))).toBe(false);
  });

  test("fails closed with a kill when explicitly requested tools do not resolve", async () => {
    const runDir = tempDir();
    const controls = fakeSpawn({});
    const spec: SubagentSpec = { prompt: "research", tools: ["web_search", "fetch_content"] };
    await expect(spawnSubprocessChild(spec, fakeParent(runDir), { sessionsDir: join(runDir, "sessions") }, spawnFor(controls)))
      .rejects.toThrow(/Missing explicitly requested tools: web_search, fetch_content/);
    expect(controls.killed).toEqual(["SIGKILL"]);
  });

  test("captures a schema result from tool events and terminates the turn", async () => {
    const runDir = tempDir();
    const controls = fakeSpawn({});
    const spec: SubagentSpec = { prompt: "report", schema: { type: "object" } };
    const child = await spawnSubprocessChild(spec, fakeParent(runDir), { sessionsDir: join(runDir, "sessions") }, spawnFor(controls));
    expect(child.schemaCapture?.called).toBe(false);

    const prompt = child.session.prompt("report");
    await Bun.sleep(0);
    controls.emit({ type: "agent_start" });
    controls.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "report_result", args: { answer: 42 } });
    controls.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "report_result", result: "ok", isError: false });
    expect(child.schemaCapture?.called).toBe(false);
    expect(controls.sent).toContainEqual({ type: "abort" });
    controls.emit({ type: "agent_settled" });
    await prompt;

    expect(child.schemaCapture?.called).toBe(true);
    expect(child.schemaCapture?.value).toEqual({ answer: 42 });
  });

  test("ignores failed report_result executions", async () => {
    const runDir = tempDir();
    const controls = fakeSpawn({});
    const spec: SubagentSpec = { prompt: "report", schema: { type: "object" } };
    const child = await spawnSubprocessChild(spec, fakeParent(runDir), { sessionsDir: join(runDir, "sessions") }, spawnFor(controls));
    const prompt = child.session.prompt("report");
    await Bun.sleep(0);
    controls.emit({ type: "agent_start" });
    controls.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "report_result", args: { bad: true } });
    controls.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "report_result", result: "invalid", isError: true });
    controls.emit({ type: "agent_settled" });
    await prompt;
    expect(child.schemaCapture?.called).toBe(false);
  });

  test("schema capture poisoning is scoped to one prompt attempt", async () => {
    const runDir = tempDir();
    const controls = fakeSpawn({});
    const child = await spawnSubprocessChild(
      { prompt: "report", schema: { type: "object" } },
      fakeParent(runDir),
      { sessionsDir: join(runDir, "sessions") },
      spawnFor(controls),
    );

    const first = child.session.prompt("first attempt");
    await Bun.sleep(0);
    controls.emit({ type: "agent_start" });
    controls.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "report_result", args: { stale: true } });
    controls.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "report_result", result: "ok", isError: false });
    controls.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "report_result", result: "duplicate", isError: false });
    controls.emit({ type: "agent_settled" });
    await first;
    expect(child.schemaCapture?.called).toBe(false);

    const second = child.session.prompt("repair attempt");
    await Bun.sleep(0);
    controls.emit({ type: "agent_settled" });
    await Bun.sleep(0);
    expect(child.schemaCapture?.called).toBe(false);
    controls.emit({ type: "agent_start" });
    controls.emit({ type: "tool_execution_start", toolCallId: "c2", toolName: "report_result", args: { answer: 42 } });
    controls.emit({ type: "tool_execution_end", toolCallId: "c2", toolName: "report_result", result: "ok", isError: false });
    controls.emit({ type: "agent_settled" });
    await second;

    expect(child.schemaCapture?.called).toBe(true);
    expect(child.schemaCapture?.value).toEqual({ answer: 42 });
  });

  test("answers blocking extension UI requests with cancellation", async () => {
    const runDir = tempDir();
    const controls = fakeSpawn({});
    await spawnSubprocessChild({ prompt: "task" }, fakeParent(runDir), { sessionsDir: join(runDir, "sessions") }, spawnFor(controls));
    controls.emit({ type: "extension_ui_request", id: "u1", method: "confirm", title: "Proceed?" });
    controls.emit({ type: "extension_ui_request", id: "u2", method: "notify", message: "fyi" });
    expect(controls.rawSent).toEqual([{ type: "extension_ui_response", id: "u1", cancelled: true }]);
  });

  test("refuses the spawn when the reported toolset still exposes orchestration tools", async () => {
    const runDir = tempDir();
    const controls = fakeSpawn({});
    const breachSpawn = (command: readonly string[], spawnOptions: { cwd: string; env?: NodeJS.ProcessEnv }): ChildRpc => {
      const specPath = spawnOptions.env?.[SHIM_SPEC_ENV];
      const spec = JSON.parse(readFileSync(specPath!, "utf8")) as { toolReportPath: string };
      writeToolReport(spec.toolReportPath, { activeTools: ["read", "workflow"] });
      return controls.rpc;
    };
    await expect(spawnSubprocessChild({ prompt: "task" }, fakeParent(runDir), { sessionsDir: join(runDir, "sessions") }, breachSpawn))
      .rejects.toThrow(/Recursion guard/);
    expect(controls.killed).toEqual(["SIGKILL"]);
  });

  test("keeps the shim spec alive for the child (reload re-reads it) and removes it at process exit", async () => {
    const runDir = tempDir();
    const controls = fakeSpawn({});
    let specPath: string | undefined;
    let reportPath: string | undefined;
    const trackingSpawn = (command: readonly string[], spawnOptions: { cwd: string; env?: NodeJS.ProcessEnv }): ChildRpc => {
      specPath = spawnOptions.env?.[SHIM_SPEC_ENV];
      const spec = JSON.parse(readFileSync(specPath!, "utf8")) as { toolReportPath: string };
      reportPath = spec.toolReportPath;
      writeToolReport(reportPath, { activeTools: ["read"] });
      return controls.rpc;
    };
    const child = await spawnSubprocessChild({ prompt: "task" }, fakeParent(runDir), { sessionsDir: join(runDir, "sessions") }, trackingSpawn);
    // The child may re-read its spec on session reload; it must survive construction.
    expect(existsSync(specPath!)).toBe(true);
    await child.session.dispose();
    await Bun.sleep(0);
    expect(existsSync(specPath!)).toBe(false);
    expect(existsSync(reportPath!)).toBe(false);
  });

  test("a spawn refused before launch leaves no shim files behind", async () => {
    const runDir = tempDir();
    const neverSpawn = (): ChildRpc => { throw new Error("spawn must not be reached"); };
    await expect(spawnSubprocessChild({ prompt: "x", tools: ["read,write"] }, fakeParent(runDir), { sessionsDir: join(runDir, "sessions") }, neverSpawn))
      .rejects.toThrow(/comma/);
    // Arg validation runs before any file write, so nothing needs cleanup.
    expect(existsSync(join(runDir, "shim"))).toBe(false);
  });

  test("a synchronous spawn failure removes shim files and surfaces the original error", async () => {
    const runDir = tempDir();
    const failure = new Error("bad cwd");
    const throwingSpawn = (): ChildRpc => { throw failure; };
    let caught: unknown;
    try {
      await spawnSubprocessChild({ prompt: "x" }, fakeParent(runDir), { sessionsDir: join(runDir, "sessions") }, throwingSpawn);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(readdirSync(join(runDir, "shim"))).toEqual([]);
  });

  test("resolves a compiled shim path beside a compiled extension entry", () => {
    expect(resolveShimPath("/install/dist/extensions/subagent-workflow.js")).toBe("/install/dist/extensions/child-shim.js");
    expect(resolveShimPath("/checkout/extensions/subagent-workflow.ts")).toBe("/checkout/extensions/child-shim.ts");
  });

  test("adds report_result to an explicit tools narrowing when a schema is present", async () => {
    const runDir = tempDir();
    const controls = fakeSpawn({});
    await spawnSubprocessChild({ prompt: "report", tools: ["read"], schema: { type: "object" } }, fakeParent(runDir), { sessionsDir: join(runDir, "sessions") }, spawnFor(controls));
    const command = controls.spawnedCommands[0]!;
    const toolsValue = command[command.indexOf("--tools") + 1];
    expect(toolsValue).toBe("read,report_result");
  });

  test("threads a follow-up fork without requesting the source schema tool", async () => {
    const runDir = tempDir();
    const sourceSession = join(runDir, "source.jsonl");
    writeFileSync(sourceSession, "transcript\n");
    const controls = fakeSpawn({});
    await spawnSubprocessChild(
      { prompt: "continue", tools: ["read"] },
      fakeParent(runDir),
      { sessionsDir: join(runDir, "sessions"), forkSessionFile: sourceSession },
      spawnFor(controls),
    );
    const command = controls.spawnedCommands[0]!;
    expect(command[command.indexOf("--fork") + 1]).toBe(sourceSession);
    expect(command[command.indexOf("--tools") + 1]).toBe("read");
  });
});

describe("child shim", () => {
  function fakePi(overrides?: { activeTools?: string[] }): { pi: ExtensionAPI; registered: string[]; fire: (event: string) => void } {
    const handlers = new Map<string, () => void>();
    const registered: string[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => { registered.push(tool.name); },
      on: (event: string, handler: () => void) => { handlers.set(event, handler); },
      getActiveTools: () => overrides?.activeTools ?? ["read", "report_result"],
    } as unknown as ExtensionAPI;
    return { pi, registered, fire: (event) => handlers.get(event)?.() };
  }

  test("is inert without the spec environment variable", () => {
    const { pi, registered } = fakePi();
    childShim(pi);
    expect(registered).toEqual([]);
  });

  test("registers report_result from the spec schema and publishes the tool report", async () => {
    const dir = tempDir();
    const specPath = join(dir, "spec.json");
    const reportPath = join(dir, "tools.json");
    require("node:fs").writeFileSync(specPath, JSON.stringify({ schema: { type: "object" }, toolReportPath: reportPath }));
    process.env[SHIM_SPEC_ENV] = specPath;

    const { pi, registered, fire } = fakePi();
    childShim(pi);
    expect(registered).toEqual(["report_result"]);
    expect(existsSync(reportPath)).toBe(false);
    fire("resources_discover");
    const report = await readToolReport(reportPath);
    expect(report).toEqual({ activeTools: ["read", "report_result"] });
  });

  test("publishes a tool report without registering a tool when there is no schema", async () => {
    const dir = tempDir();
    const specPath = join(dir, "spec.json");
    const reportPath = join(dir, "tools.json");
    require("node:fs").writeFileSync(specPath, JSON.stringify({ toolReportPath: reportPath }));
    process.env[SHIM_SPEC_ENV] = specPath;
    const { pi, registered, fire } = fakePi();
    childShim(pi);
    fire("resources_discover");
    expect(registered).toEqual([]);
    expect((await readToolReport(reportPath))?.activeTools).toEqual(["read", "report_result"]);
  });
});
