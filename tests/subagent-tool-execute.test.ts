import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedFollowUpSpec } from "../src/runner/child.js";
import { acknowledgeDeliveryMessage, releasePendingDeliveries } from "../src/store/delivery-marker.js";
import { acquireRunOwnership } from "../src/store/lease.js";
import type { SubagentRunner } from "../src/runner/runner.js";
import { formatDelivery, registerSubagentTool, type SubagentToolInput } from "../src/tool/subagent-tool.js";
import type { ResolvedSpec, SubagentHandle, SubagentResult } from "../src/types.js";
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

function harness(child: SubagentHandle, appendEntry: (type: string, data: unknown) => void,
  widget?: SubagentStatusWidget, degraded?: string,
  resolveFollowUp: (id: string, prompt: string, cwd: string) => ResolvedFollowUpSpec = () => { throw new Error("unexpected follow-up"); },
  // Most tests exercise the interactive-host background path; headless tests
  // opt out explicitly.
  hasUI = true) {
  resetProtocolRun();
  let registered: ToolDefinition<any, any, any> | undefined;
  const delivered: string[] = [];
  const marked: string[] = [];
  const spawned: unknown[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition<any, any, any>) => { registered = tool; },
    getThinkingLevel: () => "off",
    appendEntry,
    sendUserMessage: (message: string) => { delivered.push(message); },
  } as unknown as ExtensionAPI;
  const runner = {
    spawnRun: (spec: unknown) => { spawned.push(spec); return child; },
    finalizedRunWarning: () => degraded,
    markDelivered: (runId: string) => { marked.push(runId); return degraded; },
  } as unknown as SubagentRunner;
  registerSubagentTool(pi, "/extension.ts", widget, runner, resolveFollowUp);
  const ctx = {
    cwd: "/tmp",
    hasUI,
    model: { provider: "test", id: "tiny" },
    modelRegistry: {
      find: (provider: string, id: string) => provider === "test" && id === "tiny" ? { provider, id } : undefined,
      getAll: () => [{ provider: "test", id: "tiny" }],
    },
    sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" },
  };
  return { tool: registered!, delivered, marked, spawned, runner, ctx };
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

test("subagent tool guidance favors self-contained prompts and background delivery", () => {
  const h = harness(handle(Promise.resolve(result())), () => {});
  const properties = (h.tool.parameters as {
    properties: Record<string, { description?: string }>;
  }).properties;

  expect(h.tool.description).toContain("The global semaphore paces all spawns");
  expect(h.tool.description).toContain("up to about eight");
  expect(h.tool.description).toContain("changes return as a patch, never applied automatically");
  expect(h.tool.description).toContain("Every run is background");
  expect(h.tool.description).toContain("do not wait or poll");
  expect(h.tool.description).toContain("call this tool several times in the same turn");
  expect(h.tool.description).toContain("forks a completed child's persisted session into a new child and run");
  expect(properties.prompt?.description).toContain("does not receive the parent conversation");
  expect(properties.tools?.description).toContain("Normally omit");
  expect(properties).not.toHaveProperty("wait");
  expect(properties).not.toHaveProperty("specs");
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

test("a spawn returns a launch receipt and delivers in the background", async () => {
  let settle!: (value: SubagentResult) => void;
  const pending = new Promise<SubagentResult>((resolve) => { settle = resolve; });
  const h = harness(handle(pending), () => {});

  const output = await h.tool.execute("call", { prompt: "work", label: "worker" } as SubagentToolInput, undefined, undefined, h.ctx as never);
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";

  expect(JSON.parse(text)).toEqual({ id: "child-1", runId: "run-1", runDir, status: "running", label: "worker" });
  // The receipt resolves the display model itself; handle.resolved is not
  // populated yet at receipt time.
  expect(output.details).toMatchObject({ children: [{ id: "child-1", label: "worker", modelId: "tiny" }] });
  expect(h.marked).toEqual([]);
  expect(h.delivered).toEqual([]);

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

test("a turn abort does not touch the spawned child", async () => {
  let abortCount = 0;
  const child = handle(new Promise<SubagentResult>(() => {}), async () => { abortCount += 1; });
  const h = harness(child, () => {});
  const controller = new AbortController();
  controller.abort();

  const output = await h.tool.execute("call", { prompt: "work" } as SubagentToolInput, controller.signal, undefined, h.ctx as never);

  expect(abortCount).toBe(0);
  expect(output.content[0]).toMatchObject({ type: "text" });
});

test("a follow-up resolves to a forked spec and spawns a new background run", async () => {
  let settle!: (value: SubagentResult) => void;
  const pending = new Promise<SubagentResult>((resolve) => { settle = resolve; });
  const child = handle(pending);
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
    followUp: { id: "run-source/source-child", prompt: "more" },
  } as SubagentToolInput, undefined, undefined, h.ctx as never);

  expect(h.spawned).toEqual([resolvedFollowUp]);
  expect(output.content[0]).toMatchObject({ type: "text" });
  expect(h.marked).toEqual([]);
  settle(result());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.marked).toEqual(["run-1"]);
});

test("a call naming an unknown model fails fast with a suggestion", async () => {
  const entries: unknown[] = [];
  const h = harness(handle(Promise.resolve(result())), (_type, data) => entries.push(data));
  const modelRegistry = {
    find: (provider: string, id: string) => (provider === "claude-bridge" && id === "claude-sonnet-5" ? { provider, id } : undefined),
    getAll: () => [{ provider: "claude-bridge", id: "claude-sonnet-5" }],
  };

  await expect(h.tool.execute("call", {
    prompt: "a", model: "anthropic/claude-5-sonnet",
  } as SubagentToolInput, undefined, undefined, { ...h.ctx, modelRegistry } as never))
    .rejects.toThrow('Did you mean "claude-bridge/claude-sonnet-5"?');
  expect(entries).toEqual([]); // no run-started marker: nothing spawned
});

test("subagent delivery preserves failed-child tails after exact duplicate collapse", () => {
  const noisy = [
    ...Array.from({ length: 25 }, () => "PDF warning"),
    ...Array.from({ length: 80 }, (_, index) => `parser detail ${index}: ${"noise".repeat(8)}`),
    "fatal RPC frame-cap error",
  ].join("\n");
  const text = formatDelivery("run-noisy", "/runs/run-noisy", {
    ...result("failed"),
    error: noisy,
  });

  expect(text).toContain("fatal RPC frame-cap error");
  expect(text).toContain("earlier output truncated");
  expect(text).toContain("including 24 repeats");
  expect(text).not.toContain("parser detail 0:");
  expect(Math.max(...text.split("\n").map((line) => line.length))).toBeLessThanOrEqual(500);
});

test("background completion delivers the bounded envelope with the degraded marker", async () => {
  const oversized = { ...result("failed"), text: "x".repeat(20_000), error: "model unavailable" };
  const background = harness(handle(Promise.resolve(oversized)), () => {}, undefined, "events write failed");
  await background.tool.execute("background", { prompt: "work" } as SubagentToolInput, undefined, undefined, background.ctx as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const backgroundText = background.delivered[0] ?? "";

  expect(backgroundText.length).toBe(16_000);
  expect(backgroundText).toContain("Status: failed");
  expect(backgroundText).toContain("Child child-1 (child): failed");
  expect(backgroundText).toContain("Failed child child-1 (child): model unavailable");
  expect(backgroundText).toContain("Recovery: respawn the child");
  expect(backgroundText).toContain("Warning: run persistence degraded (events write failed)");
  expect(backgroundText).toContain(`Run record: ${runDir}/run.json`);
  expect(backgroundText).toContain("Child child-1 session: /sessions/child-1.jsonl");
  expect(backgroundText).toContain(`[truncated - result may be incomplete at ${runDir}/events.jsonl; run persistence degraded]`);
});

test("a headless host waits inline and returns the delivery envelope directly", async () => {
  const h = harness(handle(Promise.resolve(result())), () => {}, undefined, undefined, undefined, false);

  const output = await h.tool.execute("call", { prompt: "work" } as SubagentToolInput, undefined, undefined, h.ctx as never);
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";

  // The result is delivered in the tool return, fenced against redelivery,
  // and nothing is queued as a steered message.
  expect(text).toContain("Subagent run run-1");
  expect(text).toContain('"text":"done-child-1"');
  expect(output.details).toBeUndefined();
  expect(h.marked).toEqual(["run-1"]);
  expect(h.delivered).toEqual([]);
  expect(JSON.parse(readFileSync(deliveredPath, "utf8"))).toEqual({
    v: 1,
    sessionId: "parent",
    catchUp: false,
    generation: 1,
  });
});

test("a headless turn abort cancels the inline-waited child", async () => {
  let abortCount = 0;
  let settle!: (value: SubagentResult) => void;
  const pending = new Promise<SubagentResult>((resolve) => { settle = resolve; });
  const child = handle(pending, async () => {
    abortCount += 1;
    settle(result("aborted"));
  });
  const h = harness(child, () => {}, undefined, undefined, undefined, false);
  const controller = new AbortController();

  const execution = h.tool.execute("call", { prompt: "work" } as SubagentToolInput, controller.signal, undefined, h.ctx as never);
  await Promise.resolve();
  controller.abort();

  const output = await execution;
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";
  expect(abortCount).toBe(1);
  expect(text).toContain("Status: aborted");
});
