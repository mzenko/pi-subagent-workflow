import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as diagnostics from "../src/diagnostics.js";
import { SubagentRunner } from "../src/runner/runner.js";
import type { ChildSession } from "../src/runner/child-session.js";
import { Semaphore } from "../src/runner/semaphore.js";
import { RunStore } from "../src/store/run-store.js";
import { hasSessionClosedMarker } from "../src/store/session-closed-marker.js";
import { resolveFollowUpSpec } from "../src/tool/subagent-tool.js";
import type { ParentContext, ResolvedFollowUpSpec } from "../src/runner/child.js";
import type { ResolvedSpec, SubagentHandle, SubagentResult, SubagentSpec } from "../src/types.js";

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });

test("runner hot reload ignores the old v16 process singleton", async () => {
  const moduleUrl = new URL("../src/runner/runner.ts", import.meta.url).href;
  const script = [
    "const oldKey = '__piSubagentWorkflowRunner_v16__';",
    "const currentKey = '__piSubagentWorkflowRunner_v17__';",
    "const sentinel = {};",
    "globalThis[oldKey] = sentinel;",
    "const { subagentRunner } = await import(" + JSON.stringify(moduleUrl) + ");",
    "if (subagentRunner === sentinel) throw new Error('reused v16 runner');",
    "if (globalThis[currentKey] !== subagentRunner) throw new Error('v17 runner not installed');",
    "if (globalThis[oldKey] !== sentinel) throw new Error('v16 runner entry changed');",
  ].join(String.fromCharCode(10));
  const probe = Bun.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "pipe" });
  try {
    const [exitCode, stderr] = await Promise.all([probe.exited, new Response(probe.stderr).text()]);
    if (exitCode !== 0) throw new Error(`runner hot-reload probe failed (code ${exitCode}):\n${stderr}`);
  } finally {
    probe.kill();
    await probe.exited;
  }
});

test("waited-run registry detaches idempotently and stays session-scoped", () => {
  const runner = new SubagentRunner();
  const detached: string[] = [];
  runner.registerWaitedRun("run-a", "session-a", () => { detached.push("run-a"); return true; });
  runner.registerWaitedRun("run-b", "session-b", () => { throw new Error("broken detach"); });
  runner.registerWaitedRun("run-c", "session-a", () => { detached.push("run-c"); return true; });
  runner.registerWaitedRun("run-e", "session-b", () => { detached.push("run-e"); return true; });
  runner.registerWaitedRun("run-f", "session-b", () => false);

  expect(runner.waitedRunIds("session-a")).toEqual(["run-a", "run-c"]);
  expect(runner.waitedRunIds("session-b")).toEqual(["run-b", "run-e", "run-f"]);
  expect(runner.detachWaitedRun("run-a", "session-b")).toBe(false);
  expect(runner.waitedRunIds("session-a")).toEqual(["run-a", "run-c"]);
  expect(runner.detachWaitedRun("run-a", "session-a")).toBe(true);
  expect(runner.detachWaitedRun("run-a", "session-a")).toBe(false);
  expect(detached).toEqual(["run-a"]);

  runner.unregisterWaitedRun("run-c");
  expect(runner.detachWaitedRun("run-c", "session-a")).toBe(false);
  runner.registerWaitedRun("run-d", "session-a", () => { detached.push("run-d"); return true; });
  expect(runner.detachWaitedRuns("session-a")).toEqual(["run-d"]);
  expect(detached).toEqual(["run-a", "run-d"]);
  expect(runner.waitedRunIds("session-a")).toEqual([]);
  expect(runner.waitedRunIds("session-b")).toEqual(["run-b", "run-e", "run-f"]);

  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  const diagnostic = spyOn(diagnostics, "reportDiagnostic").mockImplementation((message) => { console.error(message); });
  try {
    expect(runner.detachWaitedRun("run-b", "session-b")).toBe(false);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("run-b"));
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("broken detach"));

    runner.registerWaitedRun("run-b", "session-b", () => { throw new Error("broken detach"); });
    expect(runner.detachWaitedRuns("session-b")).toEqual(["run-e"]);
  } finally {
    diagnostic.mockRestore();
    errorLog.mockRestore();
  }
  expect(detached).toEqual(["run-a", "run-d", "run-e"]);
  expect(runner.waitedRunIds("session-b")).toEqual([]);
  expect(runner.detachWaitedRuns("session-b")).toEqual([]);
});

function controllableDelay(): {
  delay: (ms: number) => Promise<void>;
  calls: () => number;
  waitForCalls: (count: number) => Promise<void>;
  resolveNext: () => number;
} {
  const pending: Array<{ ms: number; resolve: () => void }> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  let callCount = 0;
  return {
    delay: (ms) => new Promise<void>((resolve) => {
      callCount += 1;
      pending.push({ ms, resolve });
      for (const waiter of waiters.splice(0)) {
        if (callCount >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
    }),
    calls: () => callCount,
    waitForCalls: (count) => callCount >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => { waiters.push({ count, resolve }); }),
    resolveNext: () => {
      const next = pending.shift();
      if (!next) throw new Error("No pending delay to resolve");
      next.resolve();
      return next.ms;
    },
  };
}

function runnerParent(sessionId = "parent", cwd = "/tmp"): ParentContext {
  return { ctx: { cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
}

test("runner records the fully resolved spec and never rejects", async () => {
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "low", tools: ["read"], cwd: "/tmp", label: "tiny" };
  const session = {
    sessionFile: "/child.jsonl",
    latestAssistant: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }, stopReason: "stop" },
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
    subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, abort: async () => {}, dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "low", selfPath: "/extension.ts" } as unknown as ParentContext;
  const handle = runner.spawn({ prompt: "answer", label: "tiny" }, parent);
  const result = await handle.result;
  expect(result.status).toBe("completed");
  expect(result.sessionFile).toBe("/child.jsonl");
  expect(result.text).toBe("ok");
  expect(result.resolved).toEqual(resolved);
  expect(handle.resolved).toEqual(resolved);
  expect(result.usage).toMatchObject({ input: 1, output: 2, turns: 1 });
});

test("terminal extraction clears the retained assistant while preserving the full result text", async () => {
  const fullText = "complete result ".repeat(4_000);
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "memory" };
  let latestAssistant: Record<string, unknown> | undefined = {
    role: "assistant",
    content: [{ type: "text", text: fullText }],
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    stopReason: "error",
    errorMessage: "terminal failure",
  };
  let clearCount = 0;
  const session = {
    sessionFile: "/memory-child.jsonl",
    get latestAssistant() { return latestAssistant as never; },
    clearLatestAssistant: () => { latestAssistant = undefined; clearCount += 1; },
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
    subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, abort: async () => {}, dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore);

  const result = await runner.spawn({ prompt: "answer" }, runnerParent()).result;

  expect(result).toMatchObject({ status: "failed", error: "terminal failure", text: fullText });
  expect(latestAssistant).toBeUndefined();
  expect(clearCount).toBe(1);
});

test("the runner folds activity incrementally by persisted child id", async () => {
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: ["read", "bash"], cwd: "/tmp", label: "activity" };
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  let latestAssistant: Record<string, unknown> | undefined;
  const session = {
    sessionFile: "/activity-child.jsonl",
    get latestAssistant() { return latestAssistant as never; },
    usage: zeroUsage(),
    subscribe: (next: (event: Record<string, unknown>) => void) => { listener = next; return () => { listener = undefined; }; },
    prompt: async () => {
      listener?.({ type: "tool_execution_start", toolName: "read", args: { path: "/a" } });
      listener?.({ type: "tool_execution_start", toolName: "read", args: { path: "/b" } });
      listener?.({ type: "tool_execution_start", toolName: "bash", args: { command: "true" } });
      latestAssistant = {
        role: "assistant", content: [{ type: "text", text: "done" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop",
      };
    },
    steer: async () => {}, abort: async () => {}, dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore);

  const handle = runner.spawn({ prompt: "work", label: "activity" }, runnerParent());
  await handle.result;

  expect(runner.runActivityFold(handle.runId)?.children.get(handle.id)).toEqual({
    label: "activity",
    tools: { read: 2, bash: 1 },
  });
});

test("the runner maintains a full projection only while it owns the run", async () => {
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: ["read"], cwd: "/tmp", label: "projected" };
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  let latestAssistant: Record<string, unknown> | undefined;
  let releasePrompt!: () => void;
  let signalActivity!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const activitySeen = new Promise<void>((resolve) => { signalActivity = resolve; });
  const usage = zeroUsage();
  const session = {
    sessionFile: "/projected-child.jsonl",
    get latestAssistant() { return latestAssistant as never; },
    usage,
    subscribe: (next: (event: Record<string, unknown>) => void) => { listener = next; return () => { listener = undefined; }; },
    prompt: async () => {
      listener?.({ type: "tool_execution_start", toolName: "read", args: { path: "/work" } });
      Object.assign(usage, { input: 2, output: 3, cost: 0.01, turns: 1 });
      listener?.({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "working" }],
          usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
          stopReason: "stop",
        },
      });
      signalActivity();
      await promptGate;
      latestAssistant = {
        role: "assistant", content: [{ type: "text", text: "done" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop",
      };
    },
    steer: async () => {}, abort: async () => {}, dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore);

  const handle = runner.spawn({ prompt: "work", label: "projected" }, runnerParent());
  await activitySeen;

  expect(runner.runProjection(handle.runId)).toMatchObject({
    summary: { status: "running", total: 1, done: 0, tokens: 5 },
    detail: {
      status: "running",
      children: [{
        id: handle.id,
        label: "projected",
        model: "tiny",
        status: "running",
        tokens: 5,
        activity: 'read {"path":"/work"}',
        sessionFile: "/projected-child.jsonl",
      }],
    },
  });

  releasePrompt();
  await handle.result;
  expect(runner.runProjection(handle.runId)).toBeUndefined();
});

test("follow-ups fork immutable source sessions into independent new runs", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "subagent-runner-follow-up-"));
  const cwd = "/work/follow-up-runner";
  const source = new RunStore("run-source", cwd, "parent", undefined, { rootDir });
  const sourceSession = join(source.sessionsDir, "source.jsonl");
  writeFileSync(sourceSession, "source transcript\n");
  source.addChild("source-child", { prompt: "structured source", tools: ["read"], schema: { type: "object" } });
  source.resolveChild("source-child", {
    provider: "test", modelId: "tiny", thinkingLevel: "high", tools: ["read", "report_result"], cwd, label: "source",
  }, sourceSession);
  source.recordEvent({ type: "status", id: "source-child", status: "completed" });
  const sourceBytes = readFileSync(sourceSession);

  let forkCount = 0;
  const builtSpecs: SubagentSpec[] = [];
  const runner = new SubagentRunner(async (spec, _parent, persistence) => {
    builtSpecs.push(spec);
    const forkFile = join(persistence.sessionsDir, `fork-${++forkCount}.jsonl`);
    copyFileSync(persistence.forkSessionFile!, forkFile);
    let latestAssistant: Record<string, unknown> | undefined;
    const usage = zeroUsage();
    const session = {
      sessionFile: forkFile,
      get latestAssistant() { return latestAssistant as never; },
      usage,
      subscribe: () => () => {},
      prompt: async (prompt: string) => {
        appendFileSync(forkFile, `${prompt}\n`);
        latestAssistant = {
          role: "assistant",
          content: [{ type: "text", text: `done ${prompt}` }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          stopReason: "stop",
        };
        usage.input += 1; usage.output += 1; usage.turns += 1;
      },
      steer: async () => {}, abort: async () => {}, dispose: async () => {},
    } as unknown as ChildSession;
    return {
      session,
      resolved: {
        provider: "test", modelId: "tiny", thinkingLevel: spec.thinkingLevel ?? "off", tools: spec.tools ?? [],
        cwd: spec.cwd ?? cwd, label: spec.label ?? "follow-up",
      },
    };
  }, new Semaphore(2), (runId) => new RunStore(runId, cwd, "parent", undefined, { rootDir }));
  const parent = runnerParent();
  const followUp = (prompt: string): ResolvedFollowUpSpec => ({
    spec: { prompt, model: "test/tiny", thinkingLevel: "high", tools: ["read"], cwd, label: "source" },
    forkSessionFile: sourceSession,
    followUpOf: { runId: "run-source", childId: "source-child" },
  });

  const first = runner.spawnRun([followUp("first continuation")], parent)[0]!;
  const second = runner.spawnRun([followUp("second continuation")], parent)[0]!;
  const [firstResult, secondResult] = await Promise.all([first.result, second.result]);

  expect(readFileSync(sourceSession).equals(sourceBytes)).toBe(true);
  expect(first.runId).not.toBe(second.runId);
  expect(first.runId).not.toBe("run-source");
  expect(firstResult.sessionFile?.startsWith(join(first.runDir, "sessions"))).toBe(true);
  expect(secondResult.sessionFile?.startsWith(join(second.runDir, "sessions"))).toBe(true);
  expect(firstResult.sessionFile).not.toBe(secondResult.sessionFile);
  expect(readFileSync(firstResult.sessionFile!, "utf8")).toContain("first continuation");
  expect(readFileSync(firstResult.sessionFile!, "utf8")).not.toContain("second continuation");
  expect(readFileSync(secondResult.sessionFile!, "utf8")).toContain("second continuation");
  expect(readFileSync(secondResult.sessionFile!, "utf8")).not.toContain("first continuation");
  expect(builtSpecs).toEqual([
    { prompt: "first continuation", model: "test/tiny", thinkingLevel: "high", tools: ["read"], cwd, label: "source" },
    { prompt: "second continuation", model: "test/tiny", thinkingLevel: "high", tools: ["read"], cwd, label: "source" },
  ]);
  for (const handle of [first, second]) {
    const record = JSON.parse(readFileSync(join(handle.runDir, "run.json"), "utf8"));
    expect(record.children[0].followUpOf).toEqual({ runId: "run-source", childId: "source-child" });
  }
});

test("usage remains cumulative after the child message context is compacted", async () => {
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "low", tools: [], cwd: "/tmp", label: "compacted" };
  const first = { role: "assistant", content: [{ type: "text", text: "first" }], usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, cost: { total: 0.02 } }, stopReason: "stop" };
  const second = { role: "assistant", content: [{ type: "text", text: "second" }], usage: { input: 20, output: 4, cacheRead: 6, cacheWrite: 2, cost: { total: 0.04 } }, stopReason: "stop" };
  const session = {
    sessionFile: "/compacted-child.jsonl",
    latestAssistant: second,
    // The RPC adapter's arrival-time fold remains monotonic across child compaction.
    usage: { input: 30, output: 6, cacheRead: 9, cacheWrite: 3, cost: 0.06, turns: 2 },
    subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, abort: async () => {}, dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "low", selfPath: "/extension.ts" } as unknown as ParentContext;

  const result = await runner.spawn({ prompt: "answer" }, parent).result;

  expect(result.text).toBe("second");
  expect(result.usage).toEqual({ input: 30, output: 6, cacheRead: 9, cacheWrite: 3, cost: 0.06, turns: 2 });
});

test("structured capture repair reads the newest assistant result", async () => {
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: ["report_result"], cwd: "/tmp", label: "repair" };
  const capture = { called: false, value: undefined as unknown };
  const usage = zeroUsage();
  let latestAssistant: Record<string, unknown> | undefined;
  let promptCount = 0;
  const session = {
    sessionFile: "/repair-child.jsonl",
    get latestAssistant() { return latestAssistant as never; },
    usage,
    subscribe: () => () => {},
    prompt: async () => {
      promptCount += 1;
      latestAssistant = {
        role: "assistant",
        content: [{ type: "text", text: promptCount === 1 ? "uncaptured" : "repaired result" }],
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        stopReason: "stop",
      };
      usage.input += 2;
      usage.output += 3;
      usage.cost += 0.01;
      usage.turns += 1;
      if (promptCount === 2) {
        capture.called = true;
        capture.value = { answer: 42 };
      }
    },
    steer: async () => {}, abort: async () => {}, dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved, schemaCapture: capture }), new Semaphore(1), temporaryStore);

  const result = await runner.spawn({ prompt: "answer", schema: { type: "object" } }, runnerParent()).result;

  expect(promptCount).toBe(2);
  expect(result).toMatchObject({ status: "completed", text: "repaired result", structured: { answer: 42 } });
  expect(result.usage).toMatchObject({ input: 4, output: 6, turns: 2 });
});

test("spawn observers see a durably registered fan-out before children start", async () => {
  let buildStarted = false;
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "observed" };
  const session = {
    sessionFile: "/observed-child.jsonl", latestAssistant: undefined, usage: zeroUsage(),
    subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, abort: async () => {}, dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => { buildStarted = true; return { session, resolved }; }, new Semaphore(2), temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "observer-parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  let observations = 0;
  const unsubscribe = runner.subscribeSpawns((run) => {
    observations += 1;
    expect(buildStarted).toBe(false);
    expect(run.parentSessionId).toBe("observer-parent");
    expect(run.handles).toHaveLength(2);
    const record = JSON.parse(readFileSync(join(run.runDir, "run.json"), "utf8")) as { children: unknown[] };
    expect(record.children).toHaveLength(2);
  });

  const handles = runner.spawnRun([{ prompt: "one" }, { prompt: "two" }], parent);
  await Promise.all(handles.map((handle) => handle.result));
  expect(observations).toBe(1);

  unsubscribe();
  await runner.spawn({ prompt: "three" }, parent).result;
  expect(observations).toBe(1);
});

test("a throwing spawn observer cannot prevent child execution", async () => {
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "observed" };
  const session = {
    sessionFile: "/observed-child.jsonl", latestAssistant: undefined, usage: zeroUsage(),
    subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, abort: async () => {}, dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  runner.subscribeSpawns(() => { throw new Error("broken observer"); });
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(runner.spawn({ prompt: "x" }, parent).result).resolves.toMatchObject({ status: "completed" });
  } finally {
    errorLog.mockRestore();
  }
});

test("a hung child disposal does not hold capacity or permit early retirement", async () => {
  const semaphore = new Semaphore(1);
  let reportShutdownStarted!: () => void;
  const shutdownStarted = new Promise<void>((resolve) => { reportShutdownStarted = resolve; });
  let finishShutdown!: () => void;
  const shutdownGate = new Promise<void>((resolve) => { finishShutdown = resolve; });
  let firstDisposeCount = 0;
  let buildCount = 0;
  let firstRunId!: string;
  let runner!: SubagentRunner;
  runner = new SubagentRunner(async () => {
    const first = buildCount++ === 0;
    const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: first ? "first" : "second" };
    const session = {
      sessionFile: first ? "/first-child.jsonl" : "/second-child.jsonl",
      latestAssistant: undefined,
      usage: zeroUsage(),
      subscribe: () => () => {},
      prompt: async () => {},
      steer: async () => {},
      abort: async () => {},
      // A subprocess disposal awaits real exit; model one that stalls (e.g. a
      // SIGTERM-ignoring process riding out the SIGKILL escalation).
      dispose: first ? async () => {
        runner.markDelivered(firstRunId);
        reportShutdownStarted();
        await shutdownGate;
        firstDisposeCount += 1;
      } : () => {},
    } as unknown as ChildSession;
    return { session, resolved };
  }, semaphore, temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  const first = runner.spawn({ prompt: "first" }, parent);
  firstRunId = first.runId;
  const second = runner.spawn({ prompt: "second" }, parent);

  await shutdownStarted;
  try {
    expect(runner.runHandles(first.runId).map((handle) => handle.id)).toContain(first.id);
    const secondResult = await Promise.race([
      second.result,
      Bun.sleep(500).then(() => undefined),
    ]);
    expect(secondResult).toMatchObject({ status: "completed" });
    expect(firstDisposeCount).toBe(0);
    runner.markDelivered(second.runId);
  } finally {
    finishShutdown();
    await first.result;
    await runner.disposeForSession("parent");
  }

  expect(firstDisposeCount).toBe(1);
  expect(runner.runHandles(first.runId)).toEqual([]);
  expect(semaphore.running).toBe(0);
});

test("a completed child disposes its session without retaining it", async () => {
  let resolveDisposed!: () => void;
  const disposed = new Promise<void>((resolve) => { resolveDisposed = resolve; });
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "disposed" };
  const session = {
    sessionFile: "/disposed-child.jsonl",
    latestAssistant: undefined,
    usage: zeroUsage(),
    subscribe: () => () => {},
    prompt: async () => {},
    steer: async () => {},
    abort: async () => {},
    dispose: async () => { resolveDisposed(); },
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  const handle = runner.spawn({ prompt: "x" }, parent);

  await expect(handle.result).resolves.toMatchObject({ status: "completed" });
  await disposed;

  expect(runner.liveSession(handle.id)).toBeUndefined();
});

test("a normally completed v3 child becomes follow-up eligible after session closure", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "subagent-normal-closure-"));
  const cwd = "/work/normal-closure";
  const resolved: ResolvedSpec = {
    provider: "test", modelId: "tiny", thinkingLevel: "off", tools: ["read"], cwd, label: "normal closure",
  };
  const runner = new SubagentRunner(async (_spec, _parent, persistence) => {
    const sessionFile = join(persistence.sessionsDir, "normal.jsonl");
    writeFileSync(sessionFile, "normal transcript\n");
    const session = {
      sessionFile,
      latestAssistant: undefined,
      usage: zeroUsage(),
      subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, abort: async () => {}, dispose: async () => {},
    } as unknown as ChildSession;
    return { session, resolved };
  }, new Semaphore(1), (runId) => new RunStore(runId, cwd, "parent", undefined, { rootDir }));

  const handle = runner.spawn({ prompt: "finish normally", tools: ["read"] }, runnerParent("parent", cwd));
  await expect(handle.result).resolves.toMatchObject({ status: "completed" });

  expect(hasSessionClosedMarker(handle.runDir, handle.id)).toBe(true);
  expect(resolveFollowUpSpec(`${handle.runId}/${handle.id}`, "continue", cwd, rootDir).followUpOf)
    .toEqual({ runId: handle.runId, childId: handle.id });
});

test("a failed session disposal does not publish a closure marker", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "subagent-failed-closure-"));
  const cwd = "/work/failed-closure";
  const resolved: ResolvedSpec = {
    provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd, label: "failed closure",
  };
  const runner = new SubagentRunner(async (_spec, _parent, persistence) => {
    const sessionFile = join(persistence.sessionsDir, "failed.jsonl");
    writeFileSync(sessionFile, "failed closure transcript\n");
    const session = {
      sessionFile,
      latestAssistant: undefined,
      usage: zeroUsage(),
      subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, abort: async () => {},
      dispose: async () => { throw new Error("dispose failed"); },
    } as unknown as ChildSession;
    return { session, resolved };
  }, new Semaphore(1), (runId) => new RunStore(runId, cwd, "parent", undefined, { rootDir }));
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    const handle = runner.spawn({ prompt: "finish with disposal failure" }, runnerParent("parent", cwd));
    await expect(handle.result).resolves.toMatchObject({ status: "completed" });

    expect(hasSessionClosedMarker(handle.runDir, handle.id)).toBe(false);
    expect(() => resolveFollowUpSpec(`${handle.runId}/${handle.id}`, "continue", cwd, rootDir))
      .toThrow("source session closure is not confirmed");
  } finally {
    errorLog.mockRestore();
  }
});

test("construction failure resolves as a failed result", async () => {
  const runner = new SubagentRunner(async () => { throw new Error("construction failed"); }, new Semaphore(1), temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  await expect(runner.spawn({ prompt: "x" }, parent).result).resolves.toMatchObject({ status: "failed", error: "construction failed" });
});

test("a throwing event subscriber is detached after one failure while other subscribers continue", async () => {
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "tiny" };
  const session = {
    sessionFile: "/child.jsonl", latestAssistant: undefined, usage: zeroUsage(),
    subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, abort: async () => {}, dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  const handle = runner.spawn({ prompt: "x" }, parent);
  let subscriberCalls = 0;
  const otherEvents: string[] = [];
  handle.subscribe(() => { subscriberCalls += 1; throw new Error("broken listener"); });
  handle.subscribe((event) => { otherEvents.push(event.type); });
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(handle.result).resolves.toMatchObject({ status: "completed" });
  } finally {
    errorLog.mockRestore();
  }
  expect(subscriberCalls).toBe(1);
  expect(otherEvents.length).toBeGreaterThan(1);
  expect(otherEvents.at(-1)).toBe("result");
});

test("store creation failure prevents spawn", () => {
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "tiny" };
  const session = {
    sessionFile: "/child.jsonl", latestAssistant: undefined, usage: zeroUsage(),
    subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, abort: async () => {}, dispose: async () => {},
  } as unknown as ChildSession;
  const blockedRoot = join(mkdtempSync(join(tmpdir(), "subagent-runner-store-failure-")), "file");
  writeFileSync(blockedRoot, "not a directory");
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), (runId, parent) =>
    new RunStore(runId, parent.ctx.cwd, "parent", undefined, { rootDir: blockedRoot }));
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  expect(() => runner.spawn({ prompt: "x" }, parent)).toThrow();
});

test("applying a timeout leaves an active prompt on its admission setting", async () => {
  let resolvePrompt!: () => void;
  const prompt = new Promise<void>((resolve) => { resolvePrompt = resolve; });
  let abortCount = 0;
  let latestAssistant: Record<string, unknown> | undefined;
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "timed" };
  const session = {
    sessionFile: "/timed.jsonl",
    get latestAssistant() { return latestAssistant as never; },
    usage: zeroUsage(),
    subscribe: () => () => {},
    prompt: async () => { await prompt; },
    steer: async () => {},
    abort: async () => {
      abortCount += 1;
      latestAssistant = {
        role: "assistant",
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "aborted",
      };
      resolvePrompt();
    },
    dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  const handle = runner.spawn({ prompt: "wait" }, parent);
  await Bun.sleep(10);

  runner.setAgentTimeoutMinutes(0.001);
  await Bun.sleep(80);

  expect(abortCount).toBe(0);
  resolvePrompt();
  await expect(handle.result).resolves.toMatchObject({ status: "completed" });
});

test("a timeout change during construction does not alter the admission setting", async () => {
  let reportConstructionStarted!: () => void;
  const constructionStarted = new Promise<void>((resolve) => { reportConstructionStarted = resolve; });
  let finishConstruction!: () => void;
  const constructionGate = new Promise<void>((resolve) => { finishConstruction = resolve; });
  let reportPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { reportPromptStarted = resolve; });
  let finishPrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { finishPrompt = resolve; });
  let abortCount = 0;
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "construction gated" };
  const session = {
    sessionFile: "/construction-gated.jsonl",
    latestAssistant: undefined,
    usage: zeroUsage(),
    subscribe: () => () => {},
    prompt: async () => { reportPromptStarted(); await promptGate; },
    steer: async () => {},
    abort: async () => { abortCount += 1; finishPrompt(); },
    dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => {
    reportConstructionStarted();
    await constructionGate;
    return { session, resolved };
  }, new Semaphore(1), temporaryStore);
  runner.setAgentTimeoutMinutes(0);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  const handle = runner.spawn({ prompt: "wait" }, parent);

  await constructionStarted;
  runner.setAgentTimeoutMinutes(0.001);
  finishConstruction();
  await promptStarted;
  await Bun.sleep(80);
  finishPrompt();

  await expect(handle.result).resolves.toMatchObject({ status: "completed" });
  expect(abortCount).toBe(0);
});

test("a queued child captures its timeout before waiting for admission", async () => {
  const semaphore = new Semaphore(1);
  const releaseBlocker = await semaphore.acquire();
  let finishPrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { finishPrompt = resolve; });
  let abortCount = 0;
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "queued timeout" };
  const session = {
    sessionFile: "/queued-timeout.jsonl", latestAssistant: undefined, usage: zeroUsage(),
    subscribe: () => () => {}, prompt: async () => { await promptGate; }, steer: async () => {},
    abort: async () => { abortCount += 1; finishPrompt(); }, dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), semaphore, temporaryStore);
  runner.setAgentTimeoutMinutes(0);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  const handle = runner.spawn({ prompt: "wait" }, parent);
  await Promise.resolve();
  runner.setAgentTimeoutMinutes(0.001);
  releaseBlocker();
  await Bun.sleep(80);
  finishPrompt();

  await expect(handle.result).resolves.toMatchObject({ status: "completed" });
  expect(abortCount).toBe(0);
});

test("a timed-out schema child does not start an unbounded repair prompt", async () => {
  let promptCount = 0;
  let resolvePrompt!: () => void;
  const prompt = new Promise<void>((resolve) => { resolvePrompt = resolve; });
  let latestAssistant: Record<string, unknown> | undefined;
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: ["report_result"], cwd: "/tmp", label: "schema timed" };
  const session = {
    sessionFile: "/schema-timed.jsonl",
    get latestAssistant() { return latestAssistant as never; },
    usage: zeroUsage(),
    subscribe: () => () => {},
    prompt: async () => { promptCount += 1; await prompt; },
    steer: async () => {},
    abort: async () => {
      latestAssistant = {
        role: "assistant",
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "aborted",
      };
      resolvePrompt();
    },
    dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({
    session,
    resolved,
    schemaCapture: { called: false },
  }), new Semaphore(1), temporaryStore);
  runner.setAgentTimeoutMinutes(0.001);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;

  const result = await runner.spawn({ prompt: "return structured output", schema: { type: "object" } }, parent).result;

  expect(result.status).toBe("aborted");
  expect(promptCount).toBe(1);
});

test("a timed-out isolated child still returns its collected worktree changes", async () => {
  const repo = mkdtempSync(join(tmpdir(), "subagent-runner-timeout-worktree-"));
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "base.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);

  let resolvePrompt!: () => void;
  const prompt = new Promise<void>((resolve) => { resolvePrompt = resolve; });
  let latestAssistant: Record<string, unknown> | undefined;
  const runner = new SubagentRunner(async (spec) => {
    writeFileSync(join(spec.cwd!, "timed-change.txt"), "preserved\n");
    const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: spec.cwd!, label: "isolated" };
    const session = {
      sessionFile: "/isolated.jsonl",
      get latestAssistant() { return latestAssistant as never; },
      usage: zeroUsage(),
      subscribe: () => () => {},
      prompt: async () => { await prompt; },
      steer: async () => {},
      abort: async () => {
        latestAssistant = {
          role: "assistant",
          content: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          stopReason: "aborted",
        };
        resolvePrompt();
      },
      dispose: async () => {},
    } as unknown as ChildSession;
    return { session, resolved };
  }, new Semaphore(1), temporaryStore);
  runner.setAgentTimeoutMinutes(0.001);
  const parent = { ctx: { cwd: repo, sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;

  const result = await runner.spawn({ prompt: "edit", isolation: "worktree" }, parent).result;

  expect(result.status).toBe("aborted");
  expect(result.changed).toEqual(["timed-change.txt"]);
  expect(result.patch).toContain("+preserved");
});

test("worktree collection includes writes landing up to child disposal", async () => {
  const repo = mkdtempSync(join(tmpdir(), "subagent-runner-shutdown-worktree-"));
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "base.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: repo, label: "late write" };
  const runner = new SubagentRunner(async (spec) => ({
    resolved: { ...resolved, cwd: spec.cwd! },
    session: {
      sessionFile: "/late-write.jsonl",
      latestAssistant: undefined, usage: zeroUsage(), subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, abort: async () => {},
      // Disposal awaits real process exit; a child may flush final writes on
      // its way down, and collection must still see them.
      dispose: async () => { writeFileSync(join(spec.cwd!, "late.txt"), "written during shutdown\n"); },
    } as unknown as ChildSession,
  }), new Semaphore(1), temporaryStore);
  const parent = { ctx: { cwd: repo, sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;

  const result = await runner.spawn({ prompt: "edit", cwd: repo, isolation: "worktree" }, parent).result;

  expect(result.changed).toContain("late.txt");
  expect(result.patch).toContain("written during shutdown");
});

test("an abort after session shutdown leaves worktree collection authoritative", async () => {
  const repo = mkdtempSync(join(tmpdir(), "subagent-runner-collection-abort-"));
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "base.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);

  let handle!: SubagentHandle;
  let aborting: Promise<void> | undefined;
  const runner = new SubagentRunner(async (spec) => {
    writeFileSync(join(spec.cwd!, "collected.txt"), "keep me\n");
    return {
      resolved: { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: spec.cwd!, label: "collection race" },
      session: {
        sessionFile: "/collection-race.jsonl",
        latestAssistant: undefined,
        usage: zeroUsage(),
        subscribe: () => () => {},
        prompt: async () => {},
        steer: async () => {},
        abort: async () => {},
        dispose: async () => { aborting = handle.abort(); },
      } as unknown as ChildSession,
    };
  }, new Semaphore(1), temporaryStore);
  const parent = { ctx: { cwd: repo, sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  handle = runner.spawn({ prompt: "edit", isolation: "worktree" }, parent);
  const finish = spyOn(handle as unknown as { finish(result: SubagentResult): void }, "finish");

  const result = await handle.result;
  await aborting;

  expect(result.changed).toEqual(["collected.txt"]);
  expect(result.patch).toContain("+keep me");
  expect(finish).toHaveBeenCalledTimes(1);
});

test("zero agent timeout leaves an active prompt alone", async () => {
  let resolvePrompt!: () => void;
  const prompt = new Promise<void>((resolve) => { resolvePrompt = resolve; });
  let abortCount = 0;
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "untimed" };
  const session = {
    sessionFile: "/untimed.jsonl",
    latestAssistant: undefined,
    usage: zeroUsage(),
    subscribe: () => () => {},
    prompt: async () => { await prompt; },
    steer: async () => {},
    abort: async () => { abortCount += 1; resolvePrompt(); },
    dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore);
  runner.setAgentTimeoutMinutes(0);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  const handle = runner.spawn({ prompt: "wait" }, parent);

  await Bun.sleep(80);
  expect(abortCount).toBe(0);
  resolvePrompt();
  await expect(handle.result).resolves.toMatchObject({ status: "completed" });
});

test("runner setting methods validate unsafe values", () => {
  const runner = new SubagentRunner(async () => { throw new Error("not used"); }, new Semaphore(1), temporaryStore);
  expect(() => runner.setMaxConcurrentAgents(0)).toThrow("Semaphore capacity must be positive");
  expect(() => runner.setAgentTimeoutMinutes(Number.NaN)).toThrow("Agent timeout minutes must be a non-negative number");
});

test("session disposal cancels queued initial semaphore admission", async () => {
  const semaphore = new Semaphore(1);
  const blocker = await semaphore.acquire();
  const runner = new SubagentRunner(async () => { throw new Error("must not construct"); }, semaphore, temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  const handle = runner.spawn({ prompt: "queued" }, parent);
  await Promise.resolve();
  expect(semaphore.pending).toBe(1);

  await runner.disposeForSession("parent");

  expect(semaphore.pending).toBe(0);
  await expect(handle.result).resolves.toMatchObject({ status: "aborted" });
  blocker();
  expect(semaphore.running).toBe(0);
});

test("session disposal waits for active construction cleanup", async () => {
  const semaphore = new Semaphore(1);
  let finishConstruction!: () => void;
  let constructionStarted!: () => void;
  const started = new Promise<void>((resolve) => { constructionStarted = resolve; });
  const gate = new Promise<void>((resolve) => { finishConstruction = resolve; });
  let promptCalled = false;
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "tiny" };
  const session = {
    sessionFile: "/child.jsonl", latestAssistant: undefined, usage: zeroUsage(),
    subscribe: () => () => {}, prompt: async () => { promptCalled = true; }, steer: async () => {}, abort: async () => {}, dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => {
    constructionStarted();
    await gate;
    return { session, resolved };
  }, semaphore, temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  const handle = runner.spawn({ prompt: "constructing" }, parent);
  await started;
  let disposed = false;
  const disposal = runner.disposeForSession("parent").then(() => { disposed = true; });
  await Promise.resolve();
  runner.markDelivered(handle.runId);
  expect(disposed).toBe(false);
  expect(runner.runHandles(handle.runId)).toHaveLength(1);
  expect(semaphore.running).toBe(1);

  finishConstruction();
  await disposal;

  expect(semaphore.running).toBe(0);
  expect(promptCalled).toBe(false);
  await expect(handle.result).resolves.toMatchObject({ status: "aborted" });
  expect(runner.runHandles(handle.runId)).toEqual([]);
});

test("concurrent handle aborts share one session abort", async () => {
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  let finishPrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { finishPrompt = resolve; });
  let finishAbort!: () => void;
  const abortGate = new Promise<void>((resolve) => { finishAbort = resolve; });
  let abortCount = 0;
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "abort once" };
  const session = {
    sessionFile: "/abort-once.jsonl", latestAssistant: undefined, usage: zeroUsage(),
    subscribe: () => () => {}, prompt: async () => { promptStarted(); await promptGate; }, steer: async () => {},
    abort: async () => { abortCount += 1; finishPrompt(); await abortGate; }, dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  const handle = runner.spawn({ prompt: "wait" }, parent);
  await started;

  const first = handle.abort();
  const second = handle.abort();
  expect(second).toBe(first);
  await Promise.resolve();
  expect(abortCount).toBe(1);
  finishAbort();
  await Promise.all([first, second]);
});

test("a non-cooperative child is abandoned after abort grace and releases capacity", async () => {
  const semaphore = new Semaphore(1);
  const grace = controllableDelay();
  let reportPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { reportPromptStarted = resolve; });
  let finishFirstPrompt!: () => void;
  const firstPrompt = new Promise<void>((resolve) => { finishFirstPrompt = resolve; });
  let buildCount = 0;
  let abortCount = 0;
  const runner = new SubagentRunner(async () => {
    const first = buildCount++ === 0;
    const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: first ? "stuck" : "next" };
    const session = {
      sessionFile: first ? "/stuck-child.jsonl" : "/next-child.jsonl",
      latestAssistant: undefined,
      usage: zeroUsage(),
      subscribe: () => () => {},
      prompt: async () => { if (first) { reportPromptStarted(); await firstPrompt; } },
      steer: async () => {},
      abort: async () => { if (first) abortCount += 1; },
      dispose: async () => {},
    } as unknown as ChildSession;
    return { session, resolved };
  }, semaphore, temporaryStore, grace.delay);
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    const first = runner.spawn({ prompt: "wait forever" }, runnerParent());
    await promptStarted;

    const aborting = first.abort();
    await grace.waitForCalls(1);
    expect(grace.resolveNext()).toBe(15_000);
    await aborting;

    await expect(first.result).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("did not settle within 15s of abort"),
    });
    expect(abortCount).toBe(1);
    expect(semaphore.running).toBe(0);

    const second = runner.spawn({ prompt: "can run" }, runnerParent());
    await expect(second.result).resolves.toMatchObject({ status: "completed" });
    finishFirstPrompt();
    await Bun.sleep(0);
  } finally {
    errorLog.mockRestore();
  }
});

test("an abandoned v3 child is ineligible for follow-up until disposal publishes closure", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "subagent-abandoned-closure-"));
  const cwd = "/work/abandoned-closure";
  const grace = controllableDelay();
  let reportPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { reportPromptStarted = resolve; });
  let finishPrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { finishPrompt = resolve; });
  let reportDisposalStarted!: () => void;
  const disposalStarted = new Promise<void>((resolve) => { reportDisposalStarted = resolve; });
  let finishDisposal!: () => void;
  const disposalGate = new Promise<void>((resolve) => { finishDisposal = resolve; });
  const resolved: ResolvedSpec = {
    provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd, label: "abandoned closure",
  };
  const runner = new SubagentRunner(async (_spec, _parent, persistence) => {
    const sessionFile = join(persistence.sessionsDir, "abandoned.jsonl");
    writeFileSync(sessionFile, "abandoned transcript\n");
    const session = {
      sessionFile,
      latestAssistant: undefined,
      usage: zeroUsage(),
      subscribe: () => () => {},
      prompt: async () => { reportPromptStarted(); await promptGate; },
      steer: async () => {},
      abort: async () => {},
      dispose: async () => { reportDisposalStarted(); await disposalGate; },
    } as unknown as ChildSession;
    return { session, resolved };
  }, new Semaphore(1), (runId) => new RunStore(runId, cwd, "parent", undefined, { rootDir }), grace.delay);
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  const handle = runner.spawn({ prompt: "hang" }, runnerParent("parent", cwd));
  try {
    await promptStarted;
    const aborting = handle.abort();
    await grace.waitForCalls(1);
    grace.resolveNext();
    await aborting;
    await disposalStarted;
    await expect(handle.result).resolves.toMatchObject({ status: "failed" });

    expect(hasSessionClosedMarker(handle.runDir, handle.id)).toBe(false);
    expect(() => resolveFollowUpSpec(`${handle.runId}/${handle.id}`, "continue", cwd, rootDir))
      .toThrow("source session closure is not confirmed");

    finishDisposal();
    for (let attempt = 0; attempt < 100 && !hasSessionClosedMarker(handle.runDir, handle.id); attempt += 1) {
      await Bun.sleep(1);
    }
    expect(hasSessionClosedMarker(handle.runDir, handle.id)).toBe(true);
    expect(resolveFollowUpSpec(`${handle.runId}/${handle.id}`, "continue", cwd, rootDir).followUpOf)
      .toEqual({ runId: handle.runId, childId: handle.id });
  } finally {
    finishDisposal();
    finishPrompt();
    await Bun.sleep(0);
    errorLog.mockRestore();
  }
});

test("a cooperative abort within grace keeps the aborted result", async () => {
  const grace = controllableDelay();
  let reportPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { reportPromptStarted = resolve; });
  let finishPrompt!: () => void;
  const prompt = new Promise<void>((resolve) => { finishPrompt = resolve; });
  let latestAssistant: Record<string, unknown> | undefined;
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "cooperative" };
  const session = {
    sessionFile: "/cooperative-child.jsonl",
    get latestAssistant() { return latestAssistant as never; },
    usage: zeroUsage(),
    subscribe: () => () => {},
    prompt: async () => { reportPromptStarted(); await prompt; },
    steer: async () => {},
    abort: async () => {
      latestAssistant = {
        role: "assistant",
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "aborted",
      };
      finishPrompt();
    },
    dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore, grace.delay);
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    const handle = runner.spawn({ prompt: "stop cooperatively" }, runnerParent());
    await promptStarted;

    await handle.abort();

    await expect(handle.result).resolves.toMatchObject({ status: "aborted" });
    expect(grace.calls()).toBe(1);
    expect(errorLog).not.toHaveBeenCalledWith(expect.stringContaining("was abandoned after the grace period"));
  } finally {
    errorLog.mockRestore();
  }
});

test("a timed-out non-cooperative child is abandoned after grace", async () => {
  const semaphore = new Semaphore(1);
  const grace = controllableDelay();
  let reportPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { reportPromptStarted = resolve; });
  let finishPrompt!: () => void;
  const prompt = new Promise<void>((resolve) => { finishPrompt = resolve; });
  let abortCount = 0;
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "timeout stuck" };
  const session = {
    sessionFile: "/timeout-stuck.jsonl",
    latestAssistant: undefined,
    usage: zeroUsage(),
    subscribe: () => () => {},
    prompt: async () => { reportPromptStarted(); await prompt; },
    steer: async () => {},
    abort: async () => { abortCount += 1; },
    dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), semaphore, temporaryStore, grace.delay);
  runner.setAgentTimeoutMinutes(0.000_01);
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    const handle = runner.spawn({ prompt: "time out" }, runnerParent());
    await promptStarted;
    await grace.waitForCalls(1);

    expect(abortCount).toBe(1);
    expect(grace.resolveNext()).toBe(15_000);
    await expect(handle.result).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("timed out and did not settle within 15s grace"),
    });
    expect(semaphore.running).toBe(0);
    finishPrompt();
    await Bun.sleep(0);
  } finally {
    errorLog.mockRestore();
  }
});

test("late orphan settlement cannot replace an abandonment failure", async () => {
  const grace = controllableDelay();
  let reportPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { reportPromptStarted = resolve; });
  let finishPrompt!: () => void;
  const prompt = new Promise<void>((resolve) => { finishPrompt = resolve; });
  const latestAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "late success" }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    stopReason: "stop",
  };
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "late" };
  const session = {
    sessionFile: "/late-child.jsonl",
    latestAssistant,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
    subscribe: () => () => {},
    prompt: async () => { reportPromptStarted(); await prompt; },
    steer: async () => {},
    abort: async () => {},
    dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore, grace.delay);
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    const handle = runner.spawn({ prompt: "finish late" }, runnerParent());
    await promptStarted;
    const aborting = handle.abort();
    await grace.waitForCalls(1);
    grace.resolveNext();
    await aborting;
    const abandoned = await handle.result;

    finishPrompt();
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(await handle.result).toBe(abandoned);
    expect(abandoned).toMatchObject({ status: "failed", error: expect.stringContaining("terminated after the grace period") });
    expect(abandoned.text).toBe("late success");
  } finally {
    errorLog.mockRestore();
  }
});

test("disposeForSession stops joining a non-cooperative child's startup after grace", async () => {
  const grace = controllableDelay();
  let reportPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { reportPromptStarted = resolve; });
  let finishPrompt!: () => void;
  const prompt = new Promise<void>((resolve) => { finishPrompt = resolve; });
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "dispose stuck" };
  const session = {
    sessionFile: "/dispose-stuck.jsonl",
    latestAssistant: undefined,
    usage: zeroUsage(),
    subscribe: () => () => {},
    prompt: async () => { reportPromptStarted(); await prompt; },
    steer: async () => {},
    abort: async () => {},
    dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore, grace.delay);
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    const handle = runner.spawn({ prompt: "dispose parent" }, runnerParent("dispose-parent"));
    await promptStarted;
    runner.markDelivered(handle.runId);

    const disposal = runner.disposeForSession("dispose-parent");
    await grace.waitForCalls(1);
    grace.resolveNext();
    await grace.waitForCalls(2);
    grace.resolveNext();
    await disposal;

    await expect(handle.result).resolves.toMatchObject({ status: "failed", error: expect.stringContaining("did not settle") });
    expect(runner.liveRunIds()).not.toContain(handle.runId);
    expect(runner.runHandles(handle.runId)).toEqual([]);
    finishPrompt();
    await Bun.sleep(0);
  } finally {
    errorLog.mockRestore();
  }
});

test("a construction-window abort disposes its session exactly once", async () => {
  const semaphore = new Semaphore(1);
  let reportSteeringStarted!: () => void;
  const steeringStarted = new Promise<void>((resolve) => { reportSteeringStarted = resolve; });
  let finishSteering!: () => void;
  const steeringGate = new Promise<void>((resolve) => { finishSteering = resolve; });
  let finishAbort!: () => void;
  const abortGate = new Promise<void>((resolve) => { finishAbort = resolve; });
  let promptCount = 0;
  let disposeCount = 0;
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "constructing" };
  const session = {
    sessionFile: "/constructing-child.jsonl",
    latestAssistant: undefined,
    usage: zeroUsage(),
    subscribe: () => () => {},
    prompt: async () => { promptCount += 1; },
    steer: () => { reportSteeringStarted(); return steeringGate; },
    abort: () => { finishSteering(); return abortGate; },
    dispose: async () => { disposeCount += 1; },
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), semaphore, temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  const handle = runner.spawn({ prompt: "constructing" }, parent);
  await handle.steer("hold construction");
  await steeringStarted;

  const aborting = handle.abort();
  const releaseProbe = await semaphore.acquire();
  try {
    expect(promptCount).toBe(0);
    expect(disposeCount).toBe(0);
    expect(semaphore.running).toBe(1);
  } finally {
    releaseProbe();
    finishAbort();
    await aborting;
  }

  await expect(handle.result).resolves.toMatchObject({ status: "aborted" });
  expect(disposeCount).toBe(1);
  expect(semaphore.running).toBe(0);
  await runner.disposeForSession("parent");
  expect(disposeCount).toBe(1);
});

test("a steer sent before session construction is buffered and flushed", async () => {
  let reportConstructionStarted!: () => void;
  const constructionStarted = new Promise<void>((resolve) => { reportConstructionStarted = resolve; });
  let finishConstruction!: () => void;
  const constructionGate = new Promise<void>((resolve) => { finishConstruction = resolve; });
  const steers: string[] = [];
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "steer-buffer" };
  const session = {
    sessionFile: "/steer-buffer.jsonl",
    latestAssistant: undefined,
    usage: zeroUsage(),
    subscribe: () => () => {},
    prompt: async () => {},
    steer: async (text: string) => { steers.push(text); },
    abort: async () => {},
    dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => {
    reportConstructionStarted();
    await constructionGate;
    return { session, resolved };
  }, new Semaphore(1), temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  const handle = runner.spawn({ prompt: "work" }, parent);

  await constructionStarted;
  await handle.steer("queued before session");
  expect(steers).toEqual([]);
  finishConstruction();
  await handle.result;

  expect(steers).toEqual(["queued before session"]);
});

test("session disposal aborts workflow controllers owned by that parent session", async () => {
  const runner = new SubagentRunner(async () => { throw new Error("not used"); }, new Semaphore(1), temporaryStore);
  const owned = new AbortController();
  const other = new AbortController();
  let releaseOwned!: () => void;
  const ownedExecution = new Promise<void>((resolve) => { releaseOwned = resolve; });
  runner.registerRunController("workflow-owned", owned, "parent", ownedExecution);
  runner.registerRunController("workflow-other", other, "other-parent", Promise.resolve());
  expect(runner.liveRunIds()).toEqual(["workflow-owned", "workflow-other"]);

  let disposed = false;
  const disposal = runner.disposeForSession("parent").then(() => { disposed = true; });
  await Promise.resolve();

  expect(owned.signal.aborted).toBe(true);
  expect(other.signal.aborted).toBe(false);
  expect(disposed).toBe(false);
  releaseOwned();
  await disposal;
  expect(disposed).toBe(true);
});

test("stopRun waits for the registered workflow execution to release ownership", async () => {
  const runner = new SubagentRunner(async () => { throw new Error("not used"); }, new Semaphore(1), temporaryStore);
  const controller = new AbortController();
  let releaseExecution!: () => void;
  const execution = new Promise<void>((resolve) => { releaseExecution = resolve; });
  runner.registerRunController("workflow-stop-join", controller, "parent", execution);

  let stopped = false;
  const stopping = runner.stopRun("workflow-stop-join").then(() => { stopped = true; });
  await Promise.resolve();
  expect(controller.signal.aborted).toBe(true);
  expect(stopped).toBe(false);
  releaseExecution();
  await stopping;
  expect(stopped).toBe(true);
});

test("workflow children dispose on completion", async () => {
  let disposeCount = 0;
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "workflow child" };
  const session = {
    sessionFile: "/workflow-child.jsonl",
    latestAssistant: undefined,
    usage: zeroUsage(),
    subscribe: () => () => {},
    prompt: async () => {},
    steer: async () => {},
    abort: async () => {},
    dispose: async () => { disposeCount += 1; },
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
  const store = new RunStore("workflow-disposal", "/tmp", "parent", undefined, {
    rootDir: mkdtempSync(join(tmpdir(), "workflow-runner-disposal-")),
    kind: "workflow",
  });
  store.startWorkflowGeneration("return null;\n", undefined);
  const handle = runner.spawnRun([{ prompt: "x" }], parent, { runId: "workflow-disposal", store })[0]!;

  await handle.result;
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(disposeCount).toBe(1);
  expect(runner.liveSession(handle.id)).toBeUndefined();
  store.workflowFinished("completed");
  runner.markDelivered(handle.runId);
  await Bun.sleep(0);
  expect(runner.runHandles(handle.runId)).toEqual([]);
  expect((runner as unknown as { stores: Map<string, unknown> }).stores.has(handle.runId)).toBe(false);
});

function temporaryStore(runId: string, parent: ParentContext): RunStore {
  return new RunStore(runId, parent.ctx.cwd, "parent", undefined, { rootDir: mkdtempSync(join(tmpdir(), "subagent-runner-")) });
}

test("a schema child that self-terminates through report_result returns completed with its structured value", async () => {
  const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "schema" };
  const capture = { called: false, value: undefined as unknown };
  // report_result captures the value, then ends the loop via session.abort(),
  // so the final assistant message legitimately reads stopReason "aborted".
  const aborted = { role: "assistant", content: [{ type: "text", text: "" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }, stopReason: "aborted" };
  const session = {
    sessionFile: "/schema-child.jsonl",
    latestAssistant: aborted,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
    subscribe: () => () => {},
    prompt: async () => { capture.called = true; capture.value = { answer: 42 }; },
    steer: async () => {}, abort: async () => {}, dispose: async () => {},
  } as unknown as ChildSession;
  const runner = new SubagentRunner(async () => ({ session, resolved, schemaCapture: capture }), new Semaphore(1), temporaryStore);
  const parent = { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;

  const result = await runner.spawn({ prompt: "answer", schema: { type: "object" } }, parent).result;

  expect(result.status).toBe("completed");
  expect(result.structured).toEqual({ answer: 42 });
});
