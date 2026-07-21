import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedFollowUpSpec } from "../src/runner/child.js";
import { acknowledgeDeliveryMessage, releasePendingDeliveries } from "../src/store/delivery-marker.js";
import { acquireRunOwnership } from "../src/store/lease.js";
import type { SubagentRunner } from "../src/runner/runner.js";
import { registerSubagentTool, type SubagentToolInput } from "../src/tool/subagent-tool.js";
import type { ResolvedSpec, SubagentEvent, SubagentHandle, SubagentResult } from "../src/types.js";
import type { SubagentStatusWidget } from "../src/ui/status-widget.js";

const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "child" };
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
const testRoot = mkdtempSync(join(tmpdir(), "subagent-tool-delivery-"));
const runDir = join(testRoot, "run-1");
const deliveredPath = join(runDir, "delivered.json");
mkdirSync(runDir);
afterEach(() => releasePendingDeliveries("parent"));
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));

function result(status: SubagentResult["status"] = "completed", id = "child-1"): SubagentResult {
  return { id, generation: 1, status, sessionFile: `/sessions/${id}.jsonl`, text: status === "completed" ? `done-${id}` : "", error: status === "failed" ? `failed-${id}` : undefined, usage, resolved };
}

function handle(resultPromise: Promise<SubagentResult>, abort: () => Promise<void> = async () => {}, id = "child-1"): SubagentHandle {
  return {
    id,
    runId: "run-1",
    runDir,
    generation: 1,
    spec: { prompt: "work" },
    resolved,
    status: "running",
    startedAt: Date.now(),
    result: resultPromise,
    abort,
    steer: async () => {},
    subscribe: () => () => {},
  };
}

function harness(child: SubagentHandle | SubagentHandle[], appendEntry: (type: string, data: unknown) => void,
  widget?: SubagentStatusWidget, degraded?: string,
  resolveFollowUp: (id: string, prompt: string, cwd: string) => ResolvedFollowUpSpec = () => { throw new Error("unexpected follow-up"); },
  hasUI = false) {
  resetProtocolRun();
  let registered: ToolDefinition<any, any, any> | undefined;
  const delivered: string[] = [];
  const marked: string[] = [];
  const spawned: unknown[][] = [];
  const pi = {
    registerTool: (tool: ToolDefinition<any, any, any>) => { registered = tool; },
    getThinkingLevel: () => "off",
    appendEntry,
    sendUserMessage: (message: string) => { delivered.push(message); },
  } as unknown as ExtensionAPI;
  const children = Array.isArray(child) ? child : [child];
  const waited = new Map<string, { parentSessionId: string; detach: () => boolean }>();
  const detachWaitedRun = (runId: string, parentSessionId: string): boolean => {
    const entry = waited.get(runId);
    if (!entry || entry.parentSessionId !== parentSessionId) return false;
    waited.delete(runId);
    return entry.detach();
  };
  const runner = {
    spawnRun: (specs: unknown[]) => { spawned.push(specs); return children; },
    finalizedRunWarning: () => degraded,
    markDelivered: (runId: string) => { marked.push(runId); return degraded; },
    registerWaitedRun: (runId: string, parentSessionId: string, detach: () => boolean) => { waited.set(runId, { parentSessionId, detach }); },
    unregisterWaitedRun: (runId: string) => { waited.delete(runId); },
    detachWaitedRun,
    detachWaitedRuns: (parentSessionId: string) => {
      const detached: string[] = [];
      for (const [runId, entry] of waited) {
        if (entry.parentSessionId !== parentSessionId) continue;
        if (detachWaitedRun(runId, parentSessionId)) detached.push(runId);
      }
      return detached;
    },
    waitedRunIds: (parentSessionId: string) => [...waited]
      .filter(([, entry]) => entry.parentSessionId === parentSessionId)
      .map(([runId]) => runId),
  } as unknown as SubagentRunner;
  registerSubagentTool(pi, "/extension.ts", widget, runner, resolveFollowUp);
  const ctx = {
    cwd: "/tmp",
    hasUI,
    modelRegistry: {
      find: (provider: string, id: string) => provider === "test" && id === "tiny" ? { provider, id } : undefined,
      getAll: () => [{ provider: "test", id: "tiny" }],
    },
    sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" },
  };
  return { tool: registered!, delivered, marked, spawned, runner, ctx };
}

function parseWaitResult(text: string): { type: string; runId: string; runDir: string; results: SubagentResult[]; warning?: string } {
  return JSON.parse(text) as { type: string; runId: string; runDir: string; results: SubagentResult[]; warning?: string };
}

function resetProtocolRun(): void {
  rmSync(deliveredPath, { force: true });
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    v: 3,
    runId: "run-1",
    kind: "subagent",
    createdAt: "2026-01-01T00:00:00.000Z",
    parent: { sessionId: "parent" },
    children: [{ id: "child-1", spec: { prompt: "work" } }],
    delivery: { protocol: 1, generation: 1 },
  })}\n`);
  writeFileSync(join(runDir, "status.json"), `${JSON.stringify({
    status: "completed",
    children: { "child-1": { status: "completed", usage } },
  })}\n`);
  writeFileSync(join(runDir, "events.jsonl"), "");
}

test("subagent tool guidance favors self-contained prompts and automatic bounded delivery", () => {
  const h = harness(handle(Promise.resolve(result())), () => {});
  const properties = (h.tool.parameters as {
    properties: Record<string, { description?: string }>;
  }).properties;

  expect(h.tool.description).toContain("the global semaphore already paces all spawns");
  expect(h.tool.description).toContain("changes return as a patch, never applied automatically");
  expect(h.tool.description).toContain("Background delivery is the default");
  expect(h.tool.description).toContain('{ type: "subagent_results", runId, runDir, results }');
  expect(h.tool.description).toContain("forks a completed child's persisted session into a new child and run");
  expect(properties.prompt?.description).toContain("does not receive the parent conversation");
  expect(properties.tools?.description).toContain("Normally omit");
  expect(properties.wait?.description).toContain("Waiting blocks the rest of this turn until every child finishes");
  expect(properties.wait?.description).toContain("the user's only recourse is /background or b in /agents");
  expect(properties.wait?.description).toContain("returns a backgrounded running result - after that, do not poll");
});

test("background completion cleans up after queueing and marks only after matching message_start", async () => {
  rmSync(deliveredPath, { force: true });
  let appendCount = 0;
  const child = handle(Promise.resolve(result()));
  const h = harness(child, () => {
    appendCount += 1;
    if (appendCount === 2) throw new Error("parent transcript unavailable");
  });
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    await h.tool.execute("call", { prompt: "work" } as SubagentToolInput, undefined, undefined, h.ctx as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    errorLog.mockRestore();
  }

  expect(h.marked).toEqual(["run-1"]);
  expect(h.delivered).toHaveLength(1);
  expect(h.delivered[0]).toContain("Subagent run run-1");
  expect(existsSync(deliveredPath)).toBe(false);
  expect(acknowledgeDeliveryMessage("parent", "unrelated")).toBe(false);
  expect(existsSync(deliveredPath)).toBe(false);
  expect(acknowledgeDeliveryMessage("parent", h.delivered[0]!)).toBe(true);
  expect(JSON.parse(readFileSync(deliveredPath, "utf8"))).toEqual({
    v: 1,
    sessionId: "parent",
    catchUp: false,
    generation: 1,
  });
});

test("shutdown before background acknowledgement leaves the run retryable", async () => {
  const h = harness(handle(Promise.resolve(result())), () => {});
  await h.tool.execute("call", { prompt: "work" } as SubagentToolInput, undefined, undefined, h.ctx as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(h.delivered).toHaveLength(1);
  expect(existsSync(deliveredPath)).toBe(false);
  releasePendingDeliveries("parent");
  const ownership = acquireRunOwnership(runDir);
  ownership.release();
  expect(existsSync(deliveredPath)).toBe(false);
});

test("a failing status widget cannot orphan background delivery", async () => {
  const child = handle(Promise.resolve(result()));
  const widget = { track: () => { throw new Error("UI unavailable"); } } as unknown as SubagentStatusWidget;
  const h = harness(child, () => {}, widget);
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    await h.tool.execute("call", { prompt: "work" } as SubagentToolInput, undefined, undefined, h.ctx as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    errorLog.mockRestore();
  }

  expect(h.marked).toEqual(["run-1"]);
  expect(h.delivered).toHaveLength(1);
});

test("background failure delivery contains no raw terminal escape or C1 controls", async () => {
  const unsafeResolved = { ...resolved, label: "child\u001b]2;label\u0007safe\u009b31mred\u009b0m" };
  const failed: SubagentResult = {
    ...result("failed"),
    resolved: unsafeResolved,
    error: "failure\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007\u009d2;c1-title\u009cvisible",
  };
  const h = harness(handle(Promise.resolve(failed)), () => {});

  await h.tool.execute("call", { prompt: "work" } as SubagentToolInput, undefined, undefined, h.ctx as never);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(h.delivered).toHaveLength(1);
  expect(h.delivered[0]).toContain("failurelinkvisible");
  expect(h.delivered[0]).not.toMatch(/[\u001b\u007f-\u009f]/);
});

test("an already-aborted waited call aborts its child immediately", async () => {
  let abortCount = 0;
  let settle!: (value: SubagentResult) => void;
  const pending = new Promise<SubagentResult>((resolve) => { settle = resolve; });
  const child = handle(pending, async () => {
    abortCount += 1;
    settle(result("aborted"));
  });
  const h = harness(child, () => {});
  const controller = new AbortController();
  controller.abort();

  const output = await h.tool.execute("call", { prompt: "work", wait: true } as SubagentToolInput, controller.signal, undefined, h.ctx as never);

  expect(abortCount).toBe(1);
  expect(output.content[0]).toMatchObject({ type: "text" });
  expect(h.marked).toEqual(["run-1"]);
});

test("mid-wait turn abort returns the aborted child inline", async () => {
  let abortCount = 0;
  let settle!: (value: SubagentResult) => void;
  const pending = new Promise<SubagentResult>((resolve) => { settle = resolve; });
  const child = handle(pending, async () => {
    abortCount += 1;
    settle(result("aborted"));
  });
  const h = harness(child, () => {});
  const controller = new AbortController();

  const execution = h.tool.execute(
    "call",
    { prompt: "work", wait: true } as SubagentToolInput,
    controller.signal,
    undefined,
    h.ctx as never,
  );
  await Promise.resolve();
  controller.abort();

  const output = await execution;
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";
  const completed = parseWaitResult(text);

  expect(abortCount).toBe(1);
  expect(completed.type).toBe("subagent_results");
  expect(completed.results).toMatchObject([{ id: "child-1", status: "aborted" }]);
  expect(h.runner.waitedRunIds("parent")).toEqual([]);
});

test("detach refuses a waited subagent after the turn aborts", async () => {
  let abortCount = 0;
  let settle!: (value: SubagentResult) => void;
  const pending = new Promise<SubagentResult>((resolve) => { settle = resolve; });
  const child = handle(pending, async () => {
    abortCount += 1;
    settle(result("aborted"));
  });
  const h = harness(child, () => {});
  const controller = new AbortController();

  const execution = h.tool.execute(
    "call",
    { prompt: "work", wait: true } as SubagentToolInput,
    controller.signal,
    undefined,
    h.ctx as never,
  );
  await Promise.resolve();
  controller.abort();
  expect(h.runner.detachWaitedRun("run-1", "parent")).toBe(false);

  const output = await execution;
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";
  const completed = parseWaitResult(text);

  expect(abortCount).toBe(1);
  expect(completed.type).toBe("subagent_results");
  expect(completed.results).toMatchObject([{ id: "child-1", status: "aborted" }]);
  expect(h.runner.waitedRunIds("parent")).toEqual([]);
});

test("detaching a waited subagent backgrounds delivery and unbinds turn abort", async () => {
  let abortCount = 0;
  let settle!: (value: SubagentResult) => void;
  const pending = new Promise<SubagentResult>((resolve) => { settle = resolve; });
  const child = handle(pending, async () => { abortCount += 1; });
  const h = harness(child, () => {});
  const controller = new AbortController();

  const execution = h.tool.execute(
    "call",
    { prompt: "work", wait: true } as SubagentToolInput,
    controller.signal,
    undefined,
    h.ctx as never,
  );
  expect(h.runner.waitedRunIds("parent")).toEqual(["run-1"]);
  expect(h.runner.detachWaitedRun("run-1", "parent")).toBe(true);
  controller.abort();
  const output = await execution;
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";

  expect(JSON.parse(text)).toEqual({
    type: "subagent_backgrounded",
    runId: "run-1",
    runDir,
    status: "running",
    note: "The user moved this run to the background. Do not wait or poll; the result will arrive as a steered message. Continue other work or end the turn.",
  });
  expect(h.runner.waitedRunIds("parent")).toEqual([]);
  expect(h.delivered).toEqual([]);
  expect(h.marked).toEqual([]);
  expect(existsSync(deliveredPath)).toBe(false);
  expect(abortCount).toBe(0);

  settle(result());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.marked).toEqual(["run-1"]);
  expect(h.delivered).toHaveLength(1);
  expect(existsSync(deliveredPath)).toBe(false);
  expect(acknowledgeDeliveryMessage("parent", h.delivered[0]!)).toBe(true);
  expect(JSON.parse(readFileSync(deliveredPath, "utf8"))).toEqual({
    v: 1,
    sessionId: "parent",
    catchUp: false,
    generation: 1,
  });
});

test("a pre-settled child completes inline after claiming before detach", async () => {
  const h = harness(handle(Promise.resolve(result())), () => {});
  const execution = h.tool.execute(
    "call",
    { prompt: "work", wait: true } as SubagentToolInput,
    undefined,
    undefined,
    h.ctx as never,
  );

  await Promise.resolve();
  await Promise.resolve();
  expect(h.runner.detachWaitedRun("run-1", "parent")).toBe(false);

  const output = await execution;
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";
  expect(parseWaitResult(text).type).toBe("subagent_results");
  expect(h.marked).toEqual(["run-1"]);
  expect(existsSync(deliveredPath)).toBe(true);
});

test("detach claiming first backgrounds a pre-settled child without an inline marker", async () => {
  const h = harness(handle(Promise.resolve(result())), () => {});
  const execution = h.tool.execute(
    "call",
    { prompt: "work", wait: true } as SubagentToolInput,
    undefined,
    undefined,
    h.ctx as never,
  );

  expect(h.runner.detachWaitedRun("run-1", "parent")).toBe(true);
  const output = await execution;
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";

  expect(JSON.parse(text)).toMatchObject({ type: "subagent_backgrounded", runId: "run-1" });
  expect(existsSync(deliveredPath)).toBe(false);
});

test("detached subagent details preserve the latest tracker snapshot", async () => {
  let listener: ((event: SubagentEvent) => void) | undefined;
  const child = handle(new Promise<SubagentResult>(() => {}));
  child.status = "pending";
  child.subscribe = (next) => {
    listener = next;
    return () => { listener = undefined; };
  };
  const h = harness(child, () => {}, undefined, undefined, undefined, true);
  const execution = h.tool.execute(
    "call",
    { prompt: "work", wait: true } as SubagentToolInput,
    undefined,
    undefined,
    h.ctx as never,
  );

  child.status = "running";
  listener?.({ type: "status", id: child.id, status: "running" });
  expect(h.runner.detachWaitedRun("run-1", "parent")).toBe(true);

  const output = await execution;
  expect(output.details).toMatchObject({ children: [{ id: "child-1", status: "running" }] });
});

test("a follow-up resolves to a forked spec and spawns a new waited run", async () => {
  const child = handle(Promise.resolve(result()));
  const resolvedFollowUp: ResolvedFollowUpSpec = {
    spec: { prompt: "more", model: "test/tiny", thinkingLevel: "off", tools: ["read"] },
    forkSessionFile: "/runs/source/sessions/source.jsonl",
    followUpOf: { runId: "run-source", childId: "source-child" },
  };
  const h = harness(child, () => {}, undefined, undefined, (id, prompt, cwd) => {
    expect({ id, prompt, cwd }).toEqual({ id: "run-source/source-child", prompt: "more", cwd: "/tmp" });
    return resolvedFollowUp;
  });

  const output = await h.tool.execute("follow-up", {
    followUp: { id: "run-source/source-child", prompt: "more" }, wait: true,
  } as SubagentToolInput, undefined, undefined, h.ctx as never);

  expect(h.spawned).toEqual([[resolvedFollowUp]]);
  expect(output.content[0]).toMatchObject({ type: "text" });
  expect(h.marked).toEqual(["run-1"]);
});

test("wait mode round-trips structured output and worktree patch fields", async () => {
  rmSync(deliveredPath, { force: true });
  const childResult = {
    ...result(),
    structured: { answer: 42, nested: ["kept"] },
    patch: "diff --git a/file b/file\n+change\n",
    changed: ["file"],
  };
  const h = harness(handle(Promise.resolve(childResult)), () => {});

  const output = await h.tool.execute("waited", {
    prompt: "work", wait: true,
  } as SubagentToolInput, undefined, undefined, h.ctx as never);
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";

  expect(parseWaitResult(text)).toEqual({
    type: "subagent_results",
    runId: "run-1",
    runDir,
    results: [childResult],
  });
  expect(h.runner.waitedRunIds("parent")).toEqual([]);
  expect(JSON.parse(readFileSync(deliveredPath, "utf8"))).toEqual({
    v: 1,
    sessionId: "parent",
    catchUp: false,
    generation: 1,
  });
});

test("an under-budget subagent wait wrapper includes a persistence warning", async () => {
  const h = harness(handle(Promise.resolve(result())), () => {}, undefined, "events write failed");

  const output = await h.tool.execute("waited-warning", {
    prompt: "work", wait: true,
  } as SubagentToolInput, undefined, undefined, h.ctx as never);
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";

  expect(parseWaitResult(text).warning).toBe("events write failed");
});

test("a stale streamed tool-row callback cannot escape its timer", async () => {
  let settle!: (value: SubagentResult) => void;
  let listener: ((event: never) => void) | undefined;
  let unsubscribeCount = 0;
  const pending = new Promise<SubagentResult>((resolve) => { settle = resolve; });
  const child = handle(pending);
  child.subscribe = ((next: (event: never) => void) => {
    listener = next;
    return () => { listener = undefined; unsubscribeCount += 1; };
  }) as typeof child.subscribe;
  const h = harness(child, () => {});
  h.ctx.hasUI = true;
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    const execution = h.tool.execute(
      "call",
      { prompt: "work", wait: true } as SubagentToolInput,
      undefined,
      () => { throw new Error("closed row"); },
      h.ctx as never,
    );
    listener?.({ type: "status", id: child.id, status: "running" } as never);
    await Bun.sleep(120);
    settle(result());
    await expect(execution).resolves.toBeDefined();
    expect(listener).toBeUndefined();
    expect(unsubscribeCount).toBe(1);
  } finally {
    errorLog.mockRestore();
  }
});

test("waited fan-out preserves successful siblings when one child fails", async () => {
  const first = handle(Promise.resolve(result("completed", "child-1")), async () => {}, "child-1");
  const second = handle(Promise.resolve(result("failed", "child-2")), async () => {}, "child-2");
  const h = harness([first, second], () => {});

  const output = await h.tool.execute("call", {
    specs: [{ prompt: "succeed" }, { prompt: "fail" }],
    wait: true,
  } as SubagentToolInput, undefined, undefined, h.ctx as never);
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";
  const parsed = parseWaitResult(text).results;

  expect(parsed.map((entry) => entry.status)).toEqual(["completed", "failed"]);
  expect(parsed[0]?.text).toBe("done-child-1");
  expect(parsed[1]?.error).toBe("failed-child-2");
  expect(h.marked).toEqual(["run-1"]);
});

test("a mixed fan-out does not let an empty model override block valid siblings", async () => {
  const mixed = harness([handle(Promise.resolve(result("completed", "child-1")), async () => {}, "child-1"),
    handle(Promise.resolve(result("failed", "child-2")), async () => {}, "child-2")], () => {});
  const modelRegistry = { find: () => undefined, getAll: () => [] };

  const output = await mixed.tool.execute("call", {
    specs: [{ prompt: "good" }, { prompt: "bad", model: "" }],
    wait: true,
  } as SubagentToolInput, undefined, undefined, { ...mixed.ctx, modelRegistry } as never);
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";

  expect(parseWaitResult(text).results.map((entry) => entry.status)).toEqual(["completed", "failed"]);
});

test("a call whose every child names an unknown model fails fast with a suggestion", async () => {
  const entries: unknown[] = [];
  const h = harness(handle(Promise.resolve(result())), (_type, data) => entries.push(data));
  const modelRegistry = {
    find: (provider: string, id: string) => (provider === "claude-bridge" && id === "claude-sonnet-5" ? { provider, id } : undefined),
    getAll: () => [{ provider: "claude-bridge", id: "claude-sonnet-5" }],
  };

  await expect(h.tool.execute("call", {
    prompt: "a", model: "anthropic/claude-5-sonnet",
    wait: true,
  } as SubagentToolInput, undefined, undefined, { ...h.ctx, modelRegistry } as never))
    .rejects.toThrow('Did you mean "claude-bridge/claude-sonnet-5"?');
  expect(entries).toEqual([]); // no run-started marker: nothing spawned

  // A mixed fan-out spawns anyway: valid siblings are preserved and the doomed
  // spec fails as its own child entry (batch-isolation contract).
  const mixed = harness([handle(Promise.resolve(result("completed", "child-1")), async () => {}, "child-1"),
    handle(Promise.resolve(result("failed", "child-2")), async () => {}, "child-2")], () => {});
  const output = await mixed.tool.execute("call", {
    specs: [{ prompt: "good" }, { prompt: "bad", model: "anthropic/claude-5-sonnet" }],
    wait: true,
  } as SubagentToolInput, undefined, undefined, { ...mixed.ctx, modelRegistry } as never);
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";
  expect(parseWaitResult(text).results.map((entry) => entry.status)).toEqual(["completed", "failed"]);
});

test("foreground and background completion share the bounded envelope and degraded marker", async () => {
  const oversized = { ...result("failed"), text: "x".repeat(20_000), error: "model unavailable" };
  const foreground = harness(handle(Promise.resolve(oversized)), () => {}, undefined, "events write failed");
  const waited = await foreground.tool.execute("waited", {
    prompt: "work", wait: true,
  } as SubagentToolInput, undefined, undefined, foreground.ctx as never);
  const waitedText = waited.content[0]?.type === "text" ? waited.content[0].text : "";

  const background = harness(handle(Promise.resolve(oversized)), () => {}, undefined, "events write failed");
  await background.tool.execute("background", { prompt: "work" } as SubagentToolInput, undefined, undefined, background.ctx as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const backgroundText = background.delivered[0] ?? "";

  expect(waitedText).toBe(backgroundText);
  expect(waitedText.length).toBe(16_000);
  expect(waitedText).toContain("Status: failed");
  expect(waitedText).toContain("Child child-1 (child): failed");
  expect(waitedText).toContain("1 failed child (child): model unavailable");
  expect(waitedText).toContain("Recovery: respawn failed children");
  expect(waitedText).toContain("Warning: run persistence degraded (events write failed)");
  expect(waitedText).toContain(`Run record: ${runDir}/run.json`);
  expect(waitedText).toContain("Child child-1 session: /sessions/child-1.jsonl");
  expect(waitedText).toContain(`[truncated - result may be incomplete at ${runDir}/events.jsonl; run persistence degraded]`);
});
