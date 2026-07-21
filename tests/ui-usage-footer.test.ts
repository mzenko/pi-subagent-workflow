import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildRunEvent, SpawnedRun } from "../src/runner/runner.js";
import type { ResolvedSpec, SubagentEvent, SubagentHandle, SubagentResult, UsageSummary } from "../src/types.js";
import { runsDirFor } from "../src/ui/navigator/store-read.js";
import {
  formatUsageFooter,
  readUsageSnapshot,
  SubagentUsageFooter,
  USAGE_STATUS_KEY,
} from "../src/ui/usage-footer.js";

const cwd = "/work/project";

function usage(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ...overrides };
}

function resolved(provider: string, modelId: string): ResolvedSpec {
  return { provider, modelId, thinkingLevel: "off", tools: [], cwd, label: modelId };
}

class FakeHandle implements SubagentHandle {
  readonly runId: string;
  readonly runDir: string;
  readonly spec = { prompt: "test" };
  status = "running" as const;
  readonly startedAt = Date.now();
  readonly result = new Promise<SubagentResult>(() => {});
  readonly listeners = new Set<(event: SubagentEvent) => void>();
  unsubscribeCount = 0;
  publish: ((event: SubagentEvent) => void) | undefined;

  constructor(readonly id: string, run: { runId: string; runDir: string }, public resolved: ResolvedSpec | undefined) {
    this.runId = run.runId;
    this.runDir = run.runDir;
  }

  emit(event: SubagentEvent): void {
    for (const listener of this.listeners) listener(event);
    this.publish?.(event);
  }

  subscribe(listener: (event: SubagentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      if (this.listeners.delete(listener)) this.unsubscribeCount += 1;
    };
  }

  async steer(): Promise<void> {}
  async abort(): Promise<void> {}
}

class FakeRunner {
  readonly listeners = new Set<(run: SpawnedRun) => void>();
  readonly childListeners = new Set<(event: ChildRunEvent) => void>();
  readonly handles = new Map<string, SubagentHandle[]>();

  subscribeSpawns(listener: (run: SpawnedRun) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  runHandles(runId: string): SubagentHandle[] {
    return this.handles.get(runId) ?? [];
  }

  subscribeChildEvents(listener: (event: ChildRunEvent) => void): () => void {
    this.childListeners.add(listener);
    return () => { this.childListeners.delete(listener); };
  }

  spawn(run: Omit<SpawnedRun, "handles"> & { handles: readonly SubagentHandle[] }): void {
    for (const handle of run.handles) {
      if (handle instanceof FakeHandle) {
        handle.publish = (event) => {
          const observed = { runId: run.runId, runDir: run.runDir, parentSessionId: run.parentSessionId, resolved: handle.resolved, event };
          for (const listener of this.childListeners) listener(observed);
        };
      }
    }
    for (const listener of this.listeners) listener(run);
  }
}

interface StatusCall {
  key: string;
  text: unknown;
}

function context(
  calls: StatusCall[],
  options: {
    entries?: unknown[];
    oauth?: string[];
    sessionId?: string;
    setStatus?: (key: string, text: unknown) => void;
  } = {},
) {
  const oauth = new Set(options.oauth ?? []);
  return {
    cwd,
    hasUI: true,
    modelRegistry: {
      find: (provider: string, modelId: string) => ({ provider, id: modelId }),
      isUsingOAuth: (model: { provider: string; id: string }) => oauth.has(`${model.provider}/${model.id}`),
    },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-a",
      getEntries: () => options.entries ?? [],
    },
    ui: {
      setStatus: options.setStatus ?? ((key: string, text: unknown) => calls.push({ key, text })),
    },
  } as never;
}

function runFixture(root: string, runId: string): { runId: string; runDir: string } {
  const runDir = join(runsDirFor(cwd, root), runId);
  mkdirSync(runDir, { recursive: true });
  return { runId, runDir };
}

function writeSnapshot(
  runDir: string,
  children: Record<string, UsageSummary>,
  models: Record<string, ResolvedSpec> = {},
): void {
  writeFileSync(join(runDir, "status.json"), JSON.stringify({
    status: "completed",
    children: Object.fromEntries(Object.entries(children).map(([id, childUsage]) => [id, { status: "completed", usage: childUsage }])),
  }));
  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    children: Object.keys(children).map((id) => ({ id, ...(models[id] ? { resolved: models[id] } : {}) })),
  }));
}

test("formatUsageFooter renders compact tokens, cache usage, cost, and auth kind", () => {
  const total = usage({ input: 1_234, output: 2_500_000, cacheRead: 50_000, cacheWrite: 999, cost: 0.0126, turns: 2 });
  expect(formatUsageFooter(total)).toBe("WF total ↑1.2k ↓2.5M R50.0k W999 $0.013");
  expect(formatUsageFooter(total, "subscription")).toEndWith("$0.013 (sub)");
  expect(formatUsageFooter(total, "mixed")).toEndWith("$0.013 (mixed)");
  expect(formatUsageFooter(usage())).toBeUndefined();
  expect(formatUsageFooter(usage({ turns: 1 }))).toBe("WF total $0.000");
});

test("readUsageSnapshot reconciles durable status with event-log fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-footer-snapshot-"));
  const { runDir } = runFixture(root, "run-snapshot");
  writeSnapshot(runDir, { child: usage({ input: 10, output: 3, cost: 0.01, turns: 1 }) });
  // A torn/invalid child snapshot forces the event-log recovery path.
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ children: { child: { usage: { input: -1 } } } }));
  writeFileSync(join(runDir, "events.jsonl"), [
    "{broken",
    JSON.stringify({ type: "usage", id: "child", usage: usage({ input: 15, output: 2, cacheRead: 40, cost: 0.02, turns: 1 }) }),
    JSON.stringify({
      type: "result",
      id: "child",
      result: { usage: usage({ input: 14, output: 8, cacheWrite: 7, cost: 0.015, turns: 2 }), resolved: resolved("oauth", "sub-model") },
    }),
    JSON.stringify({ type: "usage", id: "invalid", usage: { input: -1 } }),
  ].join("\n"));

  const snapshot = readUsageSnapshot(runDir);
  expect(snapshot.usage.get("child")).toEqual(usage({
    input: 15,
    output: 8,
    cacheRead: 40,
    cacheWrite: 7,
    cost: 0.02,
    turns: 2,
  }));
  expect(snapshot.usage.has("invalid")).toBe(false);
  expect(snapshot.models.get("child")).toEqual({ provider: "oauth", modelId: "sub-model" });
});

test("readUsageSnapshot skips stale event history when status covers every run child", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-footer-complete-status-"));
  const { runDir } = runFixture(root, "run-complete");
  writeSnapshot(
    runDir,
    { child: usage({ input: 10, output: 3, cost: 0.01, turns: 1 }) },
    { child: resolved("api", "current-model") },
  );
  writeFileSync(join(runDir, "events.jsonl"), JSON.stringify({
    type: "result",
    id: "child",
    result: {
      usage: usage({ input: 999, output: 999, cost: 9, turns: 9 }),
      resolved: resolved("oauth", "stale-model"),
    },
  }));

  const snapshot = readUsageSnapshot(runDir);

  expect(snapshot.usage.get("child")).toEqual(usage({ input: 10, output: 3, cost: 0.01, turns: 1 }));
  expect(snapshot.models.get("child")).toEqual({ provider: "api", modelId: "current-model" });
});

test("readUsageSnapshot folds a newer event over a valid but nonterminal status snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-footer-running-status-"));
  const { runDir } = runFixture(root, "run-running");
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ children: [{ id: "child" }] }));
  writeFileSync(join(runDir, "status.json"), JSON.stringify({
    status: "running",
    children: {
      child: { status: "running", usage: usage({ input: 10, output: 2, cost: 0.01, turns: 1 }) },
    },
  }));
  writeFileSync(join(runDir, "events.jsonl"), JSON.stringify({
    type: "result",
    id: "child",
    result: {
      usage: usage({ input: 15, output: 5, cacheRead: 20, cost: 0.03, turns: 2 }),
      resolved: resolved("api", "finished-model"),
    },
  }));

  const snapshot = readUsageSnapshot(runDir);

  expect(snapshot.usage.get("child")).toEqual(usage({
    input: 15,
    output: 5,
    cacheRead: 20,
    cost: 0.03,
    turns: 2,
  }));
  expect(snapshot.models.get("child")).toEqual({ provider: "api", modelId: "finished-model" });
});

test("readUsageSnapshot recovers result model metadata missing from a terminal run record", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-footer-missing-model-"));
  const { runDir } = runFixture(root, "run-missing-model");
  writeSnapshot(runDir, { child: usage({ input: 5, output: 2, cost: 0, turns: 1 }) });
  writeFileSync(join(runDir, "events.jsonl"), JSON.stringify({
    type: "result",
    id: "child",
    result: {
      usage: usage({ input: 5, output: 2, cost: 0, turns: 1 }),
      resolved: resolved("oauth", "subscription-model"),
    },
  }));

  const snapshot = readUsageSnapshot(runDir);

  expect(snapshot.usage.get("child")).toEqual(usage({ input: 5, output: 2, cost: 0, turns: 1 }));
  expect(snapshot.models.get("child")).toEqual({ provider: "oauth", modelId: "subscription-model" });
});

test("readUsageSnapshot falls back to events when status is missing or corrupt", () => {
  for (const state of ["missing", "corrupt"] as const) {
    const root = mkdtempSync(join(tmpdir(), `usage-footer-${state}-status-`));
    const { runDir } = runFixture(root, `run-${state}`);
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ children: [{ id: "child" }] }));
    if (state === "corrupt") writeFileSync(join(runDir, "status.json"), "{broken");
    writeFileSync(join(runDir, "events.jsonl"), JSON.stringify({
      type: "usage",
      id: "child",
      usage: usage({ input: 7, output: 2, cost: 0.03, turns: 1 }),
    }));

    expect(readUsageSnapshot(runDir).usage.get("child")).toEqual(
      usage({ input: 7, output: 2, cost: 0.03, turns: 1 }),
    );
  }
});

test("attach restores persisted usage from parent-session run markers", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-footer-reload-"));
  const run = runFixture(root, "run-restored");
  writeSnapshot(
    run.runDir,
    { first: usage({ input: 1_000, output: 200, cost: 0.02, turns: 1 }), second: usage({ input: 500, cacheRead: 3_000, cost: 0.03, turns: 1 }) },
    { first: resolved("oauth", "sub-model"), second: resolved("oauth", "sub-model") },
  );
  const calls: StatusCall[] = [];
  const ctx = context(calls, {
    oauth: ["oauth/sub-model"],
    entries: [{ type: "custom", customType: "subagent-workflow:run-started", data: run }],
  });
  const footer = new SubagentUsageFooter(new FakeRunner() as never, root);

  footer.attach(ctx);

  expect(calls.at(-1)).toEqual({ key: USAGE_STATUS_KEY, text: "WF total ↑1.5k ↓200 R3.0k $0.050 (sub)" });
  footer.dispose();
});

test("live cumulative events replace each child snapshot and sum distinct children", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-footer-live-"));
  const run = runFixture(root, "run-live");
  const runner = new FakeRunner();
  const calls: StatusCall[] = [];
  const footer = new SubagentUsageFooter(runner as never, root);
  footer.attach(context(calls));
  const first = new FakeHandle("first", run, resolved("metered", "a"));
  const second = new FakeHandle("second", run, resolved("metered", "b"));
  runner.spawn({ ...run, parentSessionId: "session-a", handles: [first, second] });

  first.emit({ type: "usage", id: first.id, usage: usage({ input: 10, output: 2, cost: 0.01, turns: 1 }) });
  first.emit({ type: "usage", id: first.id, usage: usage({ input: 15, output: 3, cacheRead: 5, cost: 0.02, turns: 2 }) });
  first.emit({ type: "usage", id: first.id, usage: usage({ input: 12, output: 2, cost: 0.015, turns: 1 }) });
  second.emit({ type: "usage", id: second.id, usage: usage({ input: 5, output: 4, cacheWrite: 6, cost: 0.03, turns: 1 }) });

  expect(calls.at(-1)?.text).toBe("WF total ↑20 ↓7 R5 W6 $0.050");
  footer.dispose();
});

test("model-specific child costs are summed and OAuth mixtures are labeled", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-footer-auth-"));
  const run = runFixture(root, "run-auth");
  const runner = new FakeRunner();
  const calls: StatusCall[] = [];
  const footer = new SubagentUsageFooter(runner as never, root);
  footer.attach(context(calls, { oauth: ["oauth/sub-model"] }));
  const subscription = new FakeHandle("sub", run, resolved("oauth", "sub-model"));
  const metered = new FakeHandle("api", run, resolved("api", "priced-model"));
  runner.spawn({ ...run, parentSessionId: "session-a", handles: [subscription, metered] });

  subscription.emit({ type: "usage", id: subscription.id, usage: usage({ input: 4, cost: 0, turns: 1 }) });
  metered.emit({ type: "usage", id: metered.id, usage: usage({ output: 6, cost: 0.1234, turns: 1 }) });

  expect(calls.at(-1)?.text).toBe("WF total ↑4 ↓6 $0.123 (mixed)");
  footer.dispose();
});

test("session filtering ignores other parents and detaches old-session handles", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-footer-session-"));
  const run = runFixture(root, "run-session");
  const runner = new FakeRunner();
  const calls: StatusCall[] = [];
  const footer = new SubagentUsageFooter(runner as never, root);
  footer.attach(context(calls, { sessionId: "session-a" }));
  const other = new FakeHandle("other", run, resolved("api", "a"));
  runner.spawn({ ...run, parentSessionId: "session-b", handles: [other] });
  expect(other.listeners.size).toBe(0);

  const owned = new FakeHandle("owned", run, resolved("api", "a"));
  runner.spawn({ ...run, parentSessionId: "session-a", handles: [owned] });
  owned.emit({ type: "usage", id: owned.id, usage: usage({ input: 5, turns: 1 }) });
  expect(calls.at(-1)?.text).toBe("WF total ↑5 $0.000");

  footer.attach(context(calls, { sessionId: "session-b" }));
  expect(owned.listeners.size).toBe(0);
  const callCount = calls.length;
  owned.emit({ type: "usage", id: owned.id, usage: usage({ input: 50, turns: 2 }) });
  expect(calls).toHaveLength(callCount);
  footer.dispose();
});

test("trackRun accounts for a fully replayed workflow without a spawn event", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-footer-replay-"));
  const run = runFixture(root, "workflow-replay");
  writeSnapshot(run.runDir, { cached: usage({ input: 800, output: 100, cacheRead: 4_000, cost: 0.2, turns: 2 }) });
  const runner = new FakeRunner();
  const calls: StatusCall[] = [];
  const footer = new SubagentUsageFooter(runner as never, root);
  const ctx = context(calls);

  footer.trackRun(run.runDir, ctx);
  footer.trackRun(run.runDir, ctx);

  expect(calls.filter((call) => call.text !== undefined)).toEqual([
    { key: USAGE_STATUS_KEY, text: "WF total ↑800 ↓100 R4.0k $0.200" },
  ]);
  expect(runner.listeners.size).toBe(1);
  footer.dispose();
});

test("dispose unsubscribes observers and handles, while UI failures stay observational", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-footer-dispose-"));
  const run = runFixture(root, "run-dispose");
  const runner = new FakeRunner();
  const calls: StatusCall[] = [];
  const footer = new SubagentUsageFooter(runner as never, root);
  footer.attach(context(calls));
  const handle = new FakeHandle("child", run, resolved("api", "a"));
  runner.spawn({ ...run, parentSessionId: "session-a", handles: [handle] });
  handle.emit({ type: "usage", id: handle.id, usage: usage({ input: 2, turns: 1 }) });

  footer.dispose();

  expect(runner.listeners.size).toBe(0);
  expect(runner.childListeners.size).toBe(0);
  expect(calls.at(-1)).toEqual({ key: USAGE_STATUS_KEY, text: undefined });
  const callsAfterDispose = calls.length;
  handle.emit({ type: "usage", id: handle.id, usage: usage({ input: 20, turns: 2 }) });
  expect(calls).toHaveLength(callsAfterDispose);

  const failingRunner = new FakeRunner();
  let attempts = 0;
  const failing = new SubagentUsageFooter(failingRunner as never, root);
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    failing.attach(context([], { setStatus: () => { attempts += 1; throw new Error("UI closed"); } }));
    const failedHandle = new FakeHandle("failed-ui", run, resolved("api", "a"));
    failingRunner.spawn({ ...run, parentSessionId: "session-a", handles: [failedHandle] });
    expect(() => failedHandle.emit({ type: "usage", id: failedHandle.id, usage: usage({ input: 1, turns: 1 }) })).not.toThrow();
    failedHandle.emit({ type: "usage", id: failedHandle.id, usage: usage({ input: 2, turns: 2 }) });
    expect(attempts).toBe(1);
  } finally {
    failing.dispose();
    errorLog.mockRestore();
  }
});

test("a child with unresolved model metadata never flips an all-subscription session to (mixed)", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-footer-unresolved-"));
  const run = runFixture(root, "run-unresolved");
  const runner = new FakeRunner();
  const calls: StatusCall[] = [];
  const footer = new SubagentUsageFooter(runner as never, root);
  footer.attach(context(calls, { oauth: ["oauth/sub-model"] }));
  const subscription = new FakeHandle("sub", run, resolved("oauth", "sub-model"));
  const pending = new FakeHandle("pending", run, undefined);
  runner.spawn({ ...run, parentSessionId: "session-a", handles: [subscription, pending] });

  subscription.emit({ type: "usage", id: subscription.id, usage: usage({ input: 4, cost: 0, turns: 1 }) });
  pending.emit({ type: "usage", id: pending.id, usage: usage({ output: 3, cost: 0.01, turns: 1 }) });

  // The unresolved child's tokens and cost still count; only the auth label ignores it.
  expect(calls.at(-1)?.text).toBe("WF total ↑4 ↓3 $0.010 (sub)");
  footer.dispose();
});
