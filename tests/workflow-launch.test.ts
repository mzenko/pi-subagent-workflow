import { expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ParentContext } from "../src/runner/child.js";
import type { ChildSession } from "../src/runner/child-session.js";
import { SubagentRunner, subagentRunner } from "../src/runner/runner.js";
import { Semaphore } from "../src/runner/semaphore.js";
import { activityFoldFromSnapshot } from "../src/store/activity-fold.js";
import { RunStore } from "../src/store/run-store.js";
import { readRunSnapshot } from "../src/store/run-snapshot.js";
import { stringifyDeliveryJson } from "../src/ui/delivery-safe.js";
import { completeWorkflow, formatWorkflowDelivery, formatWorkflowResult, groupFailedChildren, launchWorkflow, formatToolActivity, summarizeActivityFold, summarizeChildToolActivity, workflowStartedMarker } from "../src/workflow/launch.js";
import { parseWorkflowScript } from "../src/workflow/parser.js";
import type { WorkflowRunResult } from "../src/workflow/workflow-runner.js";

const parent = {
  ctx: {
    cwd: "/tmp",
    model: { provider: "test", id: "parent-model" },
    sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/tmp/parent.jsonl" },
  },
  thinkingLevel: "off",
  selfPath: "/extension.ts",
} as unknown as ParentContext;

function useAgentDir(path: string): () => void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path;
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  };
}

test("launch does not append a started marker when workflow setup fails", async () => {
  const entries: unknown[] = [];
  const pi = { appendEntry: (_type: string, data: unknown) => entries.push(data) } as unknown as ExtensionAPI;
  const args: { self?: unknown } = {};
  args.self = args;
  const plan = {
    workflow: parseWorkflowScript("export const meta = { name: 'bad-launch', description: 'test' };\nreturn 1"),
    args,
    origin: "inline" as const,
  };

  await expect(launchWorkflow(pi, parent, { plan }, {
    approve: async () => {},
    ctx: { mode: "print", cwd: "/tmp", ui: {} as never },
    deps: { consent: {} as never },
  })).rejects.toThrow("Workflow args must be JSON-serializable");
  expect(entries).toEqual([]);
});

test("launch resolves only after durable startup and controller registration", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-startup-order-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  const script = "export const meta = { name: 'startup-order', description: 'test' };\nlog('authored');\nawait new Promise(() => {});\nreturn 'unreachable';\n";
  const isolatedParent = {
    ...parent,
    ctx: { ...parent.ctx, cwd },
  } as unknown as ParentContext;
  let launched: Awaited<ReturnType<typeof launchWorkflow>> | undefined;
  let runRoot: string | undefined;
  const logs: string[] = [];

  try {
    launched = await launchWorkflow({ appendEntry: () => {} } as unknown as ExtensionAPI, isolatedParent, {
      plan: { workflow: parseWorkflowScript(script), args: null, origin: "inline" },
      onLog: (message) => logs.push(message),
    }, {
      approve: async () => {},
      ctx: { mode: "print", cwd, ui: {} as never },
      deps: { consent: {} as never },
    });
    const { runId, runDir } = launched.started;
    runRoot = dirname(runDir);
    expect({
      script: readFileSync(join(runDir, "script.js"), "utf8"),
      status: JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")).status,
      eventTypes: readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n")
        .map((line) => (JSON.parse(line) as { type: string }).type),
      controllerRegistered: subagentRunner.isRunActive(runId),
    }).toEqual({
      script,
      status: "running",
      eventTypes: ["created", "workflow_started"],
      controllerRegistered: true,
    });
    expect(logs).toEqual([]);
    await subagentRunner.stopRun(runId);
    await expect(launched.execution).rejects.toThrow("Workflow stopped");
    expect(subagentRunner.isRunActive(runId)).toBe(false);
  } finally {
    if (launched) await subagentRunner.stopRun(launched.started.runId);
    await launched?.execution.catch(() => {});
    if (runRoot) rmSync(runRoot, { recursive: true, force: true });
    restoreAgentDir();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("launch returns before script logs and execution settlement", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-launch-observer-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  const script = "export const meta = { name: 'observer-order', description: 'test' };\nlog('first');\nreturn 'done';\n";
  const isolatedParent = {
    ...parent,
    ctx: { ...parent.ctx, cwd },
  } as unknown as ParentContext;
  const order: string[] = [];
  let runRoot: string | undefined;

  try {
    const launched = await launchWorkflow({ appendEntry: () => {} } as unknown as ExtensionAPI, isolatedParent, {
      plan: { workflow: parseWorkflowScript(script), args: null, origin: "inline" },
      onLog: (message) => order.push(`log:${message}`),
    }, {
      approve: async () => {},
      ctx: { mode: "print", cwd, ui: {} as never },
      deps: { consent: {} as never },
    });
    order.push("return");
    runRoot = dirname(launched.started.runDir);
    const statusAtReturn = JSON.parse(readFileSync(join(launched.started.runDir, "status.json"), "utf8")).status;
    const terminalEventAtReturn = readFileSync(join(launched.started.runDir, "events.jsonl"), "utf8").trim().split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type)
      .some((type) => ["workflow_completed", "workflow_failed", "workflow_aborted"].includes(type));
    await launched.execution.then(() => order.push("execution"));

    expect(statusAtReturn).toBe("running");
    expect(terminalEventAtReturn).toBe(false);
    expect(order).toEqual(["return", "log:first", "execution"]);
  } finally {
    if (runRoot) rmSync(runRoot, { recursive: true, force: true });
    restoreAgentDir();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow wait completion survives transcript marker failure and writes its delivery marker", () => {
  const runDir = mkdtempSync(join(tmpdir(), "workflow-wait-delivery-"));
  const pi = { appendEntry: () => { throw new Error("transcript closed"); } } as unknown as ExtensionAPI;
  writeProtocolWorkflow(runDir, "workflow-test-1", 1);
  const result = {
    runId: "workflow-test-1",
    runDir,
    generation: 1,
    meta: { name: "marker-test", description: "test" },
    result: "done",
    failedChildren: [],
  } satisfies WorkflowRunResult;
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(completeWorkflow(pi, result, "parent", () => "delivered")).toBe("delivered");
    expect(JSON.parse(readFileSync(join(runDir, "delivered.json"), "utf8"))).toEqual({
      v: 1,
      sessionId: "parent",
      catchUp: false,
      generation: 1,
    });
  } finally {
    errorLog.mockRestore();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an auto-approved TUI launch is marked in the parent transcript", () => {
  const started = { runId: "workflow-auto-1", runDir: "/tmp/workflow-auto-1", name: "auto", phases: [{ title: "Review" }] };
  expect(workflowStartedMarker(started, true)).toMatchObject({ phases: started.phases, approval: "auto" });
  expect(workflowStartedMarker(started, false)).not.toHaveProperty("approval");
});

const fakeRegistry = {
  find: (provider: string, id: string) => KNOWN_MODELS.find((model) => model.provider === provider && model.id === id),
  getAll: () => KNOWN_MODELS,
} as unknown as ParentContext["ctx"]["modelRegistry"];
const KNOWN_MODELS = [
  { provider: "claude-bridge", id: "claude-sonnet-5" },
  { provider: "openai-codex", id: "gpt-5.6-terra" },
];

function launchForModelValidation(body: string, approve: () => Promise<void>) {
  const registryParent = { ...parent, ctx: { ...parent.ctx, modelRegistry: fakeRegistry } } as unknown as ParentContext;
  const plan = {
    workflow: parseWorkflowScript(`export const meta = { name: 'model-validation', description: 'test' };\n${body}`),
    args: null,
    origin: "inline" as const,
  };
  return launchWorkflow({ appendEntry: () => {} } as unknown as ExtensionAPI, registryParent, { plan }, {
    approve,
    ctx: { mode: "print", cwd: "/tmp", ui: {} as never },
    deps: { consent: {} as never },
  });
}

test("launch accepts known and omitted literal models through approval", async () => {
  for (const body of [
    "await agent('x', { model: 'openai-codex/gpt-5.6-terra' });",
    "await agent('x');",
    "const inventory = [{ make: 'Toyota', model: 'Corolla' }]; return parallel(inventory.map((item) => () => agent('Research ' + item.model)));",
  ]) {
    let approved = 0;
    const error = await launchForModelValidation(body, async () => {
      approved += 1;
      throw new Error("approval sentinel");
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("approval sentinel");
    expect(approved).toBe(1);
  }
});

test("launch rejects unknown literal models before approval with exact suggestions", async () => {
  const cases = [
    {
      body: "await agent('x', { model: 'anthropic/claude-5-sonnet' });",
      message: 'Workflow was not launched; fix the script\'s model values first. Model not found: anthropic/claude-5-sonnet. Did you mean "claude-bridge/claude-sonnet-5"?',
    },
    {
      body: "await agent('x', { model: 'claude-sonnet-5' });",
      message: 'Workflow was not launched; fix the script\'s model values first. Invalid model "claude-sonnet-5". Expected "provider/model-id", e.g. "claude-bridge/claude-sonnet-5", or omit model to inherit the parent\'s.',
    },
  ];
  for (const { body, message } of cases) {
    let approved = 0;
    const error = await launchForModelValidation(body, async () => {
      approved += 1;
      throw new Error("unexpected approval");
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    expect(approved).toBe(0);
  }
});

test("approval cannot change the source, metadata, or models that are persisted and executed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-approved-source-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  const original = "export const meta = { name: 'approved-source', description: 'original', phases: [{ title: 'Original' }] };\nconst approvedOptions = { model: 'openai-codex/gpt-5.6-terra' };\nreturn 'original-result';\n";
  const workflow = parseWorkflowScript(original);
  const isolatedParent = {
    ...parent,
    ctx: { ...parent.ctx, cwd, modelRegistry: fakeRegistry },
  } as unknown as ParentContext;
  let runRoot: string | undefined;

  try {
    const launched = await launchWorkflow({ appendEntry: () => {} } as unknown as ExtensionAPI, isolatedParent, {
      plan: { workflow, args: null, origin: "inline" },
    }, {
      approve: async (plan) => {
        await Promise.resolve();
        expect(() => (plan.workflow as unknown as { script: string }).script = "return 'changed'").toThrow();
        expect(() => (plan.workflow.meta as { name: string }).name = "changed").toThrow();
        expect(() => (plan.workflow.meta.phases![0] as { title: string }).title = "Changed").toThrow();
        expect(() => (plan.workflow.meta.phases as Array<unknown>).push({ title: "Added" })).toThrow();
        expect(() => (plan.workflow.literalModels as string[]).push("unknown/model")).toThrow();
      },
      ctx: { mode: "print", cwd, ui: {} as never },
      deps: { consent: {} as never },
    });
    runRoot = dirname(launched.started.runDir);
    const result = await launched.execution;

    expect(launched.started).toMatchObject({ name: "approved-source", phases: [{ title: "Original" }] });
    expect(readFileSync(join(launched.started.runDir, "script.js"), "utf8")).toBe(original);
    expect(result.meta).toEqual({ name: "approved-source", description: "original", phases: [{ title: "Original" }] });
    expect(result.result).toBe("original-result");
  } finally {
    if (runRoot) rmSync(runRoot, { recursive: true, force: true });
    restoreAgentDir();
    rmSync(cwd, { recursive: true, force: true });
  }
});

function failedChild(id: string, label: string, error: string) {
  return {
    id, status: "failed" as const, text: "", error,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    resolved: { provider: "unknown", modelId: "unknown", thinkingLevel: "off" as const, tools: [], cwd: "/tmp", label },
  };
}

function runResult(failedChildren: ReturnType<typeof failedChild>[]): WorkflowRunResult {
  return {
    runId: "run-1", runDir: "/tmp/run-1", meta: { name: "m", description: "d" },
    result: { ok: true }, failedChildren,
  } as unknown as WorkflowRunResult;
}

test("identical child failures group into one line with one recovery invocation", () => {
  const result = runResult([
    failedChild("c1", "France", "Model not found: anthropic/claude-5-sonnet."),
    failedChild("c2", "Sweden", "Model not found: anthropic/claude-5-sonnet."),
    failedChild("c3", "Austria", "Model not found: anthropic/claude-5-sonnet."),
    failedChild("c4", "Malta", "Model not found: anthropic/claude-5-sonnet."),
    failedChild("c5", "Spain", "timeout"),
  ]);
  expect(groupFailedChildren(result.failedChildren)).toEqual([
    { count: 4, error: "Model not found: anthropic/claude-5-sonnet.", labels: ["France", "Sweden", "Austria"] },
    { count: 1, error: "timeout", labels: ["Spain"] },
  ]);
  const delivery = formatWorkflowDelivery(result);
  expect(delivery).toContain("4 failed children (France, Sweden, Austria, ...): Model not found");
  expect(delivery.match(/Recovery:/g)).toHaveLength(1);
});

test("an under-cap wait result includes run identity, status, failed children, and persistence warning", () => {
  const failed = failedChild("c1", "France", "boom");
  const text = formatWorkflowResult({
    ...runResult([failed]),
    persistenceWarning: "journal write degraded",
  });
  expect(JSON.parse(text)).toEqual({
    type: "workflow_result",
    runId: "run-1",
    runDir: "/tmp/run-1",
    status: "completed with 1 failed child",
    result: { ok: true },
    failedChildren: [failed],
    warning: "journal write degraded",
  });
});

test("oversized failure diagnostics fall back to the bounded prose envelope", () => {
  const text = formatWorkflowResult(runResult([failedChild("c1", "France", "y".repeat(20_000))]));
  expect(text.length).toBeLessThanOrEqual(16_000);
  expect(text).toContain("Workflow run run-1");
  expect(text).toContain("1 failed child (France):");
});

test("wait and background workflow results use one consistent bounded envelope", () => {
  const result = {
    ...runResult([failedChild("c1", "France", "boom")]),
    result: "x".repeat(20_000),
    persistenceWarning: "journal write degraded",
  };
  const waited = formatWorkflowResult(result);
  const background = formatWorkflowDelivery(result);

  expect(waited).toBe(background);
  expect(waited.length).toBe(16_000);
  expect(waited).toContain("Status: completed with 1 failed child");
  expect(waited).toContain("1 failed child (France): boom");
  expect(waited).toContain("Recovery: workflow(");
  expect(waited).toContain("Warning: journal write degraded");
  expect(waited).toContain("Result artifact: /tmp/run-1/result.json");
  expect(waited).toContain("[truncated - full result persisted at /tmp/run-1/result.json]");
  expect(waited).not.toContain("x".repeat(20_000));
});

test("a small workflow wait result uses structured JSON while background keeps prose", () => {
  const result = runResult([]);
  const waited = formatWorkflowResult(result);
  const background = formatWorkflowDelivery(result);

  expect(JSON.parse(waited)).toEqual({
    type: "workflow_result",
    runId: "run-1",
    runDir: "/tmp/run-1",
    status: "completed",
    result: { ok: true },
  });
  expect(background).toContain("Workflow run run-1");
  expect(background).toContain(stringifyDeliveryJson({ type: "workflow_result", result: { ok: true } }));
});

test("resumed workflow delivery leads with the current generation outcome and result path", () => {
  const runDir = mkdtempSync(join(tmpdir(), "workflow-resume-delivery-"));
  try {
    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      runId: "workflow-resumed",
      kind: "workflow",
      children: [
        { id: "child-1", spec: { label: "Research first attempt" } },
        { id: "child-3", spec: { label: "Research retry" } },
      ],
    }));
    writeFileSync(join(runDir, "status.json"), JSON.stringify({ status: "completed", children: {} }));
    writeFileSync(join(runDir, "script.js"), "return null;\n");
    writeFileSync(join(runDir, "events.jsonl"), [
      { type: "workflow_started", generation: 1 },
      { type: "status", id: "child-1", status: "failed" },
      { type: "workflow_started", generation: 2 },
      { type: "status", id: "child-3", status: "completed" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    const delivery = formatWorkflowDelivery({
      runId: "workflow-resumed",
      runDir,
      generation: 2,
      meta: { name: "resumed", description: "test" },
      result: { report: "x".repeat(2_000) },
      failedChildren: [],
    });

    expect(delivery.startsWith("Workflow resumed (generation 2)\nResume outcome:")).toBe(true);
    expect(delivery).toContain("Child child-3 (Research retry): completed");
    expect(delivery).not.toContain("No child reached a terminal status");
    expect(delivery).not.toContain("Child child-1");
    expect(delivery.indexOf("Resume outcome:")).toBeLessThan(delivery.indexOf(`Result artifact: ${runDir}/result.json`));
    expect(delivery.indexOf(`Result artifact: ${runDir}/result.json`)).toBeLessThan(delivery.indexOf("Result preview:"));
    expect(delivery).toContain("x".repeat(500));
    expect(Math.max(...delivery.split("\n").map((line) => line.length))).toBeLessThanOrEqual(500);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("resume delivery reads only the matching generation window", () => {
  const runDir = mkdtempSync(join(tmpdir(), "workflow-resume-window-"));
  try {
    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      runId: "workflow-resume-window",
      kind: "workflow",
      children: [
        { id: "child-current", spec: { label: "Current attempt" } },
        { id: "child-newer", spec: { label: "Newer attempt" } },
      ],
    }));
    writeFileSync(join(runDir, "status.json"), JSON.stringify({ status: "completed", children: {} }));
    writeFileSync(join(runDir, "script.js"), "return null;\n");
    writeFileSync(join(runDir, "events.jsonl"), [
      { type: "workflow_started", generation: 1 },
      { type: "status", id: "child-old", status: "failed" },
      { type: "workflow_started", generation: 2 },
      { type: "status", id: "child-current", status: "completed" },
      { type: "workflow_started", generation: 3 },
      { type: "status", id: "child-newer", status: "failed" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    const delivery = formatWorkflowDelivery({
      runId: "workflow-resume-window",
      runDir,
      generation: 2,
      meta: { name: "resumed", description: "test" },
      result: "done",
      failedChildren: [],
    });

    expect(delivery).toContain("Child child-current (Current attempt): completed");
    expect(delivery).not.toContain("Child child-old");
    expect(delivery).not.toContain("Child child-newer");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("resume delivery reports legacy generation boundaries as unavailable", () => {
  const runDir = mkdtempSync(join(tmpdir(), "workflow-resume-legacy-"));
  try {
    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      runId: "workflow-resume-legacy",
      kind: "workflow",
      children: [{ id: "child-legacy", spec: { label: "Legacy attempt" } }],
    }));
    writeFileSync(join(runDir, "status.json"), JSON.stringify({ status: "completed", children: {} }));
    writeFileSync(join(runDir, "script.js"), "return null;\n");
    writeFileSync(join(runDir, "events.jsonl"), [
      { type: "workflow_started" },
      { type: "status", id: "child-legacy", status: "completed" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    const delivery = formatWorkflowDelivery({
      runId: "workflow-resume-legacy",
      runDir,
      generation: 2,
      meta: { name: "resumed", description: "test" },
      result: "done",
      failedChildren: [],
    });

    expect(delivery).toContain("Resume outcome:\nUnavailable; inspect");
    expect(delivery).toContain(`${runDir}/events.jsonl`);
    expect(delivery).not.toContain("Child child-legacy");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("the runner's incremental activity projection matches the batch snapshot fold", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-activity-"));
  const store = new RunStore("workflow-activity", "/work/example", "parent-1", undefined, { rootDir, kind: "workflow" });
  store.startWorkflowGeneration("return null;\n", undefined);
  appendFileSync(join(store.runDir, "events.jsonl"), "{malformed\n");
  const runner = new SubagentRunner(async (spec) => {
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    let latestAssistant: Record<string, unknown> | undefined;
    const tools = spec.label === "submitted-researcher" ? ["fetch_content", "fetch_content", "web_search"] : [];
    const resolvedLabel = spec.label === "submitted-researcher" ? "resolved-researcher" : "resolved-summarizer";
    const session = {
      sessionFile: join(store.sessionsDir, `${resolvedLabel}.jsonl`),
      get latestAssistant() { return latestAssistant as never; },
      clearLatestAssistant: () => { latestAssistant = undefined; },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
      subscribe: (next: (event: Record<string, unknown>) => void) => { listener = next; return () => { listener = undefined; }; },
      prompt: async () => {
        for (const toolName of tools) listener?.({ type: "tool_execution_start", toolName, args: {} });
        latestAssistant = {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          stopReason: "stop",
        };
      },
      steer: async () => {},
      abort: async () => {},
      dispose: async () => {},
    } as unknown as ChildSession;
    return {
      session,
      resolved: { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/work/example", label: resolvedLabel },
    };
  }, new Semaphore(2), () => store);

  try {
    const handles = runner.spawnRun([
      { prompt: "research", label: "submitted-researcher" },
      { prompt: "summarize", label: "submitted-summarizer" },
    ], parent, { runId: "workflow-activity", store });
    await Promise.all(handles.map((handle) => handle.result));

    const incremental = runner.runActivityFold("workflow-activity")!;
    const batch = activityFoldFromSnapshot(readRunSnapshot(store.runDir));
    expect(incremental).toEqual(batch);
    const activity = summarizeActivityFold(incremental);
    expect(activity.groups).toEqual([
      { count: 1, examples: [{ id: handles[0]!.id, label: "resolved-researcher" }], tools: { fetch_content: 2, web_search: 1 } },
      { count: 1, examples: [{ id: handles[1]!.id, label: "resolved-summarizer" }], tools: {} },
    ]);
    expect(activity.totalChildren).toBe(2);
    expect(activity.complete).toBe(false);
    expect(formatToolActivity(activity)).toContain("[incomplete: some run records were unreadable]");
    expect(formatToolActivity(activity)).toContain(`resolved-researcher [${handles[0]!.id}]: fetch_content x2, web_search x1`);
    expect(summarizeChildToolActivity(join(rootDir, "no-such-run"))).toEqual({
      groups: [], totalChildren: 0, omittedChildren: 0, omittedToolCalls: 0, complete: false,
    });
  } finally {
    store.releaseOwnership();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("homogeneous fan-outs compress into one complete group at any scale", async () => {
  const { RunStore } = await import("../src/store/run-store.js");
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-activity-fanout-"));
  const store = new RunStore("workflow-activity-fanout", "/work/example", "parent-1", undefined, { rootDir, kind: "workflow" });
  for (let index = 0; index < 150; index += 1) {
    store.addChild(`child-${index}`, { prompt: `task ${index}`, label: `worker-${index}` });
    store.recordEvent({ type: "activity", id: `child-${index}`, description: "fetch_content {}" });
  }
  store.addChild("child-idle", { prompt: "task", label: "idler" });
  store.releaseOwnership();

  const activity = summarizeChildToolActivity(store.runDir);
  expect(activity.totalChildren).toBe(151);
  expect(activity.omittedChildren).toBe(0);
  expect(activity.groups).toHaveLength(2);
  expect(activity.groups[0]).toEqual({
    count: 150,
    examples: [0, 1, 2, 3, 4].map((index) => ({ id: `child-${index}`, label: `worker-${index}` })),
    tools: { fetch_content: 1 },
  });
  const text = formatToolActivity(activity);
  expect(text).toContain("150 children (worker-0 [child-0], worker-1 [child-1], worker-2 [child-2], worker-3 [child-3], worker-4 [child-4], ...): fetch_content x1 each");
  expect(text).toContain("idler [child-idle]: no tool calls");
});

// The reviewer reproduced a 54 KB activity block from 64 distinct long-label
// profiles: the block itself must respect a byte budget at group boundaries,
// counting whatever the budget drops instead of letting the global delivery
// truncation cut it mid-line (or cut the result pointer after it).
test("an oversized activity block is bounded at group boundaries with explicit omission", async () => {
  const { RunStore } = await import("../src/store/run-store.js");
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-activity-huge-"));
  const store = new RunStore("workflow-activity-huge", "/work/example", "parent-1", undefined, { rootDir, kind: "workflow" });
  for (let index = 0; index < 64; index += 1) {
    // Distinct tool per child = 64 distinct profiles; long labels inflate lines.
    store.addChild(`child-${index}`, { prompt: `task ${index}`, label: `${"verbose-label-".repeat(4)}${index}` });
    store.recordEvent({ type: "activity", id: `child-${index}`, description: `tool_${index} {}` });
  }
  store.releaseOwnership();

  const summary = summarizeChildToolActivity(store.runDir);
  const unbounded = formatToolActivity(summary, Number.POSITIVE_INFINITY);
  expect(unbounded.length).toBeGreaterThan(4_000);

  const eventsPath = `${store.runDir}/events.jsonl`;
  const text = formatToolActivity(summary, 4_000, eventsPath);
  expect(text.length).toBeLessThanOrEqual(4_000);
  expect(text).toMatch(/\[\+\d+ more tool calls across \d+ more children; full activity in .*\/events\.jsonl\]/);
  const shown = text.match(/tool_\d+ x1/g) ?? [];
  const omitted = Number(text.match(/\[\+(\d+) more tool calls/)?.[1]);
  expect(shown.length + omitted).toBe(64);
  expect(text.split("\n").every((line) => line.length < 2_000)).toBe(true);
  expect(text).toContain(`full activity in ${eventsPath}`);

  const delivery = formatWorkflowDelivery({
    runId: "workflow-activity-huge",
    runDir: store.runDir,
    meta: { name: "activity-huge", description: "test" },
    result: "ok",
    failedChildren: [],
  });
  // The bounded block leaves the result payload intact - no global truncation.
  expect(delivery).not.toContain("[truncated");
  expect(delivery).toContain(`Activity log: ${eventsPath}`);
  expect(delivery).toContain('{"type":"workflow_result","result":"ok"}');
});

test("tool activity omission reports children even when they made no tool calls", () => {
  const text = formatToolActivity({
    groups: [{ count: 1, examples: [{ id: "child-shown", label: "shown" }], tools: { read: 1 } }],
    totalChildren: 2,
    omittedChildren: 1,
    omittedToolCalls: 0,
    complete: true,
  }, 4_000, "/runs/idle/events.jsonl");

  expect(text).toContain("[+0 more tool calls across 1 more children; full activity in /runs/idle/events.jsonl]");
  expect(text).not.toContain("[+0 more tool calls; full activity");
});

test("tool activity marks unreadable run records as incomplete", async () => {
  const { RunStore } = await import("../src/store/run-store.js");
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-activity-corrupt-"));
  const store = new RunStore("workflow-activity-corrupt", "/work/example", "parent-1", undefined, { rootDir, kind: "workflow" });
  store.addChild("child-1", { prompt: "task", label: "worker" });
  store.releaseOwnership();

  // Partially readable: children resolve but a corrupt event line means the
  // counts may be missing data - flagged inline, not silently dropped.
  writeFileSync(join(store.runDir, "events.jsonl"), "{not json\n");
  const partial = summarizeChildToolActivity(store.runDir);
  expect(partial.complete).toBe(false);
  expect(partial.groups.map((group) => group.examples)).toEqual([[{ id: "child-1", label: "worker" }]]);
  expect(formatToolActivity(partial)).toContain("[incomplete: some run records were unreadable]");

  // Fully unreadable: an explicit unavailability line, never an empty string.
  writeFileSync(join(store.runDir, "run.json"), "{not json\n");
  const unreadable = summarizeChildToolActivity(store.runDir);
  expect(unreadable.complete).toBe(false);
  expect(formatToolActivity(unreadable)).toContain("Tool activity: unavailable");
});

test("background delivery keeps the activity summary ahead of a truncated result", async () => {
  const { RunStore } = await import("../src/store/run-store.js");
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-activity-truncate-"));
  const store = new RunStore("workflow-activity-truncate", "/work/example", "parent-1", undefined, { rootDir, kind: "workflow" });
  store.addChild("child-1", { prompt: "task", label: "worker" });
  store.recordEvent({ type: "activity", id: "child-1", description: "read {\"path\":\"/x\"}" });
  store.releaseOwnership();

  const delivery = formatWorkflowDelivery({
    runId: "workflow-activity-truncate",
    runDir: store.runDir,
    meta: { name: "activity-truncate", description: "test" },
    result: "x".repeat(20_000),
    failedChildren: [],
  });
  expect(delivery).toContain("[truncated");
  expect(delivery).toContain("Tool activity:\nworker [child-1]: read x1");
  expect(delivery.indexOf("Tool activity")).toBeLessThan(delivery.indexOf("workflow_result"));
});

function writeProtocolWorkflow(runDir: string, runId: string, generation: number): void {
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    v: 3,
    runId,
    kind: "workflow",
    createdAt: "2026-01-01T00:00:00.000Z",
    parent: { sessionId: "parent" },
    children: [],
    delivery: { protocol: 1, generation },
  })}\n`);
  writeFileSync(join(runDir, "status.json"), `${JSON.stringify({ status: "completed", children: {} })}\n`);
  writeFileSync(join(runDir, "events.jsonl"), "");
}
