import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { acknowledgeDeliveryMessage, releasePendingDeliveries } from "../src/store/delivery-marker.js";
import { formatDelivery } from "../src/tool/subagent-tool.js";
import { buildDeliveryEnvelope, DELIVERY_ENVELOPE_BUDGET, ENVELOPE_LINE_MAX } from "../src/ui/delivery-envelope.js";
import { safeDeliveryValue } from "../src/ui/delivery-safe.js";
import { deliverWorkflowInBackground, formatWorkflowDelivery, formatWorkflowFailure } from "../src/workflow/launch.js";
import { WorkflowRunError, type WorkflowRunResult } from "../src/workflow/workflow-runner.js";

const deliveryRoot = mkdtempSync(join(tmpdir(), "workflow-delivery-"));
afterEach(() => releasePendingDeliveries("parent"));
afterAll(() => rmSync(deliveryRoot, { recursive: true, force: true }));

async function captureBackgroundWorkflowDelivery(execution: Promise<WorkflowRunResult>): Promise<{ message: string; options: unknown; entries: unknown[] }> {
  const entries: unknown[] = [];
  let resolveDelivery!: (delivery: { message: string; options: unknown }) => void;
  const delivery = new Promise<{ message: string; options: unknown }>((resolve) => { resolveDelivery = resolve; });
  const pi = {
    appendEntry: (_type: string, data: unknown) => { entries.push(data); },
    sendUserMessage: (message: string, options: unknown) => { resolveDelivery({ message, options }); },
  } as unknown as ExtensionAPI;
  deliverWorkflowInBackground(pi, execution, "parent");
  return { ...await delivery, entries };
}

test("subagent failure delivery includes identity, error, and respawn recovery", () => {
  const text = formatDelivery("run-1", "/runs/run-1", [{
    id: "child-1",
    status: "failed",
    text: "",
    error: "model unavailable",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    resolved: { provider: "test", modelId: "test", thinkingLevel: "off", tools: [], cwd: "/work", label: "Audit routes" },
  }]);
  expect(text).toContain("Child child-1 (Audit routes): failed");
  expect(text).toContain("1 failed child (Audit routes): model unavailable");
  expect(text).toContain("Recovery: respawn failed children");
});

test("aborted subagent deliveries report aborts without recommending respawn", () => {
  const aborted = {
    id: "child-aborted",
    status: "aborted" as const,
    text: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    resolved: { provider: "test", modelId: "test", thinkingLevel: "off" as const, tools: [], cwd: "/work", label: "Cancelled work" },
  };
  const completed = { ...aborted, id: "child-completed", status: "completed" as const, text: "done" };

  const single = formatDelivery("run-aborted", "/runs/run-aborted", [aborted]);
  expect(single).toContain("Status: aborted");
  expect(single).not.toContain("Recovery: respawn");

  const mixed = formatDelivery("run-mixed", "/runs/run-mixed", [completed, aborted]);
  expect(mixed).toContain("Status: completed, 1 aborted");
  expect(mixed).not.toContain("Recovery: respawn");
});

test("completed workflow delivery groups failed children with one resume recovery", () => {
  const failedChild = {
    id: "child-2",
    status: "failed" as const,
    text: "",
    error: "timeout",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    resolved: { provider: "test", modelId: "test", thinkingLevel: "off" as const, tools: [], cwd: "/work", label: "Inspect API" },
  };
  const text = formatWorkflowDelivery({ runId: "workflow-2", runDir: "/runs/workflow-2", meta: { name: "test", description: "test" }, result: null, failedChildren: [failedChild] });
  expect(text).toContain("1 failed child (Inspect API): timeout");
  expect(text).toContain('workflow({ scriptPath: "/runs/workflow-2/script.js", resumeRunId: "workflow-2" })');
});

test("background workflow success delivery writes its marker and neutralizes controls", async () => {
  const C1 = "\u009b";
  const unsafeRunDir = join(deliveryRoot, `${C1}31mred`);
  mkdirSync(unsafeRunDir);
  const resultValue = {
    note: `keep${C1}31mred`,
    nested: { [`key${C1}2J-safe`]: `osc\u009dtitle\u009cafter`, del: "before\u007fafter" },
  };
  const failedChild = {
    id: `child${C1}2J-1`,
    status: "failed" as const,
    text: "",
    error: `time${C1}2Jout`,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    resolved: { provider: "test", modelId: "test", thinkingLevel: "off" as const, tools: [], cwd: "/work", label: `Inspect${C1}31m API` },
  };
  const runId = `workflow${C1}2J-safe`;
  writeProtocolWorkflow(unsafeRunDir, runId, 1);
  const { message, options, entries } = await captureBackgroundWorkflowDelivery(Promise.resolve({
    runId,
    runDir: unsafeRunDir,
    generation: 1,
    meta: { name: "test", description: "test" },
    result: resultValue,
    failedChildren: [failedChild],
    persistenceWarning: `disk${C1}2J slow`,
  }));

  expect(options).toEqual({ deliverAs: "steer" });
  expect(entries).toHaveLength(1);
  const safeRunDir = safeDeliveryValue(unsafeRunDir);
  expect(message).toContain(`Workflow run workflow-safe\nRun directory: ${safeRunDir}\n`);
  expect(message).toContain("1 failed child (Inspect API): timeout");
  expect(message).toContain(`workflow({ scriptPath: ${JSON.stringify(`${safeRunDir}/script.js`)}, resumeRunId: "workflow-safe" })`);
  expect(message).toContain("Warning: disk slow");
  expect(message).not.toMatch(/[\u007f-\u009f]/);
  expect(message).toContain("\\u009b");
  // The result JSON is located by shape, not line position: the tool-activity
  // line rides between the header and the result payload.
  const resultLine = message.split("\n").find((line) => line.startsWith('{"type":"workflow_result"'));
  expect(JSON.parse(resultLine!)).toEqual({ type: "workflow_result", result: resultValue });
  expect(existsSync(join(unsafeRunDir, "delivered.json"))).toBe(false);
  expect(acknowledgeDeliveryMessage("parent", "unrelated")).toBe(false);
  expect(existsSync(join(unsafeRunDir, "delivered.json"))).toBe(false);
  expect(acknowledgeDeliveryMessage("parent", message)).toBe(true);
  expect(JSON.parse(readFileSync(join(unsafeRunDir, "delivered.json"), "utf8"))).toEqual({
    v: 1,
    sessionId: "parent",
    catchUp: false,
    generation: 1,
  });
});

test("background workflow failure delivery writes its marker and strips controls", async () => {
  const ESC = "\u001b";
  const failedChild = {
    id: `child${ESC}[2J-1`,
    status: "failed" as const,
    text: "",
    error: `fail${ESC}[31mred`,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    resolved: { provider: "test", modelId: "test", thinkingLevel: "off" as const, tools: [], cwd: "/work", label: `Audit${ESC}]0;bad\u0007 API` },
  };
  const unsafeRunDir = join(deliveryRoot, `${ESC}]0;hidden\u0007safe`);
  mkdirSync(unsafeRunDir);
  const runId = `workflow${ESC}[2J-9`;
  writeProtocolWorkflow(unsafeRunDir, runId, 1);
  const error = new WorkflowRunError(
    `boom${ESC}[31mred\nforged`,
    runId,
    unsafeRunDir,
    `disk${ESC}Psecret${ESC}\\slow`,
    [failedChild],
    1,
  );
  const { message, options, entries } = await captureBackgroundWorkflowDelivery(Promise.reject(error));

  expect(options).toEqual({ deliverAs: "steer" });
  expect(entries).toEqual([]);
  const safeRunDir = safeDeliveryValue(unsafeRunDir);
  expect(message).toContain(`Workflow run workflow-9\nRun directory: ${safeRunDir}\nStatus: failed\nError: boomredforged`);
  expect(message).toContain("1 failed child (Audit API): failred");
  expect(message).toContain(`workflow({ scriptPath: ${JSON.stringify(`${safeRunDir}/script.js`)}, resumeRunId: "workflow-9" })`);
  expect(message).toContain("Warning: diskslow");
  expect(existsSync(join(unsafeRunDir, "delivered.json"))).toBe(false);
  expect(acknowledgeDeliveryMessage("parent", message)).toBe(true);
  expect(JSON.parse(readFileSync(join(unsafeRunDir, "delivered.json"), "utf8"))).toEqual({
    v: 1,
    sessionId: "parent",
    catchUp: false,
    generation: 1,
  });
  expect(message).not.toMatch(/[\u001b\u0080-\u009f]/);
});

test("intentionally stopped workflow delivery preserves abort intent and omits recovery", async () => {
  const runDir = join(deliveryRoot, "workflow-stopped");
  mkdirSync(runDir);
  writeProtocolWorkflow(runDir, "workflow-stopped", 1);
  const error = new WorkflowRunError(
    "Workflow stopped",
    "workflow-stopped",
    runDir,
    undefined,
    [],
    1,
    "aborted",
  );
  const { message, options } = await captureBackgroundWorkflowDelivery(Promise.reject(error));

  expect(options).toEqual({ deliverAs: "steer" });
  expect(message).toContain("Status: aborted");
  expect(message).toContain("The workflow was intentionally stopped.");
  expect(message).toContain("Do not resume it unless the user explicitly asks.");
  expect(message).not.toContain("Status: failed");
  expect(message).not.toContain("Recovery:");
  expect(message).not.toContain("resumeRunId");
});

test("a truncated workflow delivery points to the persisted result artifact", () => {
  const big = "y".repeat(20_000);
  const text = formatWorkflowDelivery({ runId: "workflow-3", runDir: "/runs/workflow-3", meta: { name: "t", description: "t" }, result: big, failedChildren: [] });
  expect(text.length).toBeLessThan(big.length);
  expect(text).toContain("[truncated - full result persisted at /runs/workflow-3/result.json]");
});

test("a degraded oversized subagent result hedges its events artifact marker", () => {
  const text = formatDelivery("run-oversized", "/runs/run-oversized", [{
    id: "child-oversized",
    status: "failed",
    sessionFile: "/sessions/child-oversized.jsonl",
    text: "z".repeat(20_000),
    // Worktree patches are collected after the child session ends, so only
    // events.jsonl contains this complete parent-added result.
    patch: "diff --git a/file b/file\n",
    error: "model unavailable",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    resolved: { provider: "test", modelId: "test", thinkingLevel: "off", tools: [], cwd: "/work", label: "Audit routes" },
  }], "events write failed");

  expect(text.length).toBe(DELIVERY_ENVELOPE_BUDGET);
  expect(text).toContain("Child child-oversized (Audit routes): failed");
  expect(text).toContain("1 failed child (Audit routes): model unavailable");
  expect(text).toContain("Recovery: respawn failed children");
  expect(text).toContain("Warning: run persistence degraded (events write failed)");
  expect(text).toContain("Run record: /runs/run-oversized/run.json");
  expect(text).toContain("Child child-oversized session: /sessions/child-oversized.jsonl");
  expect(text).toContain("[truncated - result may be incomplete at /runs/run-oversized/events.jsonl; run persistence degraded]");
});

test("a truncated subagent result without a session file points to events.jsonl", () => {
  const text = formatDelivery("run-events", "/runs/run-events", [{
    id: "child-events",
    status: "completed",
    text: "z".repeat(20_000),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    resolved: { provider: "test", modelId: "test", thinkingLevel: "off", tools: [], cwd: "/work", label: "Audit routes" },
  }]);

  const marker = text.split("\n").find((line) => line.startsWith("[truncated -"));
  expect(marker).toBe("[truncated - full result remains available via /runs/run-events/events.jsonl]");
  expect(marker).not.toContain("run.json");
});

test("a 16-child delivery drops auxiliary sessions before required markers and records", () => {
  const results = Array.from({ length: 16 }, (_, index) => ({
    id: `child-${index + 1}`,
    status: "completed" as const,
    sessionFile: `/sessions/${"long-path/".repeat(240)}child-${index + 1}.jsonl`,
    text: "z".repeat(2_000),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    resolved: { provider: "test", modelId: "test", thinkingLevel: "off" as const, tools: [], cwd: "/work", label: `Child ${index + 1}` },
  }));
  const text = formatDelivery("run-fanout", "/runs/run-fanout", results);
  const sessionLines = text.split("\n").filter((line) => /^Child child-\d+ session:/.test(line));

  expect(text.length).toBeLessThanOrEqual(DELIVERY_ENVELOPE_BUDGET);
  expect(text).toContain("[fixed sections truncated]");
  expect(text).toContain("[truncated - full result remains available via /runs/run-fanout/events.jsonl]");
  expect(text).toContain("Run record: /runs/run-fanout/run.json");
  expect(sessionLines.length).toBeLessThan(results.length);
  expect(text).not.toContain("Child child-16 session:");
});

test("a small subagent result passes through the envelope whole", () => {
  const text = formatDelivery("run-small", "/runs/run-small", [{
    id: "child-small",
    status: "completed",
    text: "all done",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    resolved: { provider: "test", modelId: "test", thinkingLevel: "off", tools: [], cwd: "/work", label: "Small task" },
  }]);

  expect(text).not.toContain("[truncated");
  expect(text).toContain('"text":"all done"');
});

test("zero and negative preview budgets return an empty hard-bounded envelope", () => {
  for (const budget of [0, -10]) {
    const text = buildDeliveryEnvelope({
      header: ["Header"],
      failures: ["Failure"],
      recovery: ["Recovery"],
      warnings: ["Warning"],
      artifacts: ["Artifact"],
      toolActivity: "Tool activity",
      resultPreview: "oversized result",
      truncationMarker: "[truncated at Artifact]",
    }, budget);
    expect(text).toBe("");
  }
});

test("delivery envelope caps each fixed-section line", () => {
  const text = buildDeliveryEnvelope({ header: ["x".repeat(ENVELOPE_LINE_MAX + 1)] });
  expect(text).toBe(`${"x".repeat(ENVELOPE_LINE_MAX - 3)}...`);
  expect(text.length).toBe(ENVELOPE_LINE_MAX);
});

test("a small envelope keeps its framing when recovery is a separate section", () => {
  const text = buildDeliveryEnvelope({
    header: ["Header"],
    failures: ["Failure"],
    recovery: ["Recovery"],
    warnings: ["Warning"],
    artifacts: ["Artifact"],
    toolActivity: "\nTool activity",
    resultPreview: "Result",
  });

  expect(text).toBe("Header\nFailure\nRecovery\nWarning\nArtifact\nTool activity\nResult preview:\nResult");
});

test("delivery envelope enforces the hard budget for adversarial sections", () => {
  const cases = [
    {
      sections: { header: ["h".repeat(100_000)] },
      fixedOmitted: false,
      previewOmitted: false,
    },
    {
      sections: { header: ["Header"], failures: Array.from({ length: 4_000 }, (_, index) => `failure ${index}`) },
      fixedOmitted: true,
      previewOmitted: false,
    },
    {
      sections: { header: [], recovery: Array.from({ length: 20 }, () => "recover ".repeat(400)), artifacts: ["Artifact: /runs/recovery/events.jsonl"] },
      fixedOmitted: true,
      previewOmitted: false,
    },
    {
      sections: {
        header: Array.from({ length: 20 }, () => "😀 header ".repeat(400)),
        failures: Array.from({ length: 2_000 }, () => "failure"),
        recovery: Array.from({ length: 20 }, () => "recovery ".repeat(400)),
        warnings: Array.from({ length: 2_000 }, () => "warning"),
        artifacts: Array.from({ length: 20 }, () => "artifact ".repeat(400)),
        auxiliaryArtifacts: Array.from({ length: 20 }, () => "auxiliary ".repeat(400)),
        toolActivity: "tool 😀 ".repeat(10_000),
        resultPreview: "result 😀 ".repeat(10_000),
        truncationMarker: "[truncated at /runs/everything/events.jsonl]",
      },
      fixedOmitted: true,
      previewOmitted: true,
    },
    {
      sections: { header: [], resultPreview: "p".repeat(100_000), truncationMarker: "[truncated]" },
      fixedOmitted: false,
      previewOmitted: true,
    },
    {
      sections: { header: ["😀".repeat(20_000)], resultPreview: "🧪".repeat(20_000), truncationMarker: "[truncated 🧭]" },
      fixedOmitted: false,
      previewOmitted: true,
    },
  ] as const;

  for (const { sections, fixedOmitted, previewOmitted } of cases) {
    const text = buildDeliveryEnvelope(sections, DELIVERY_ENVELOPE_BUDGET);
    expect(text.length).toBeLessThanOrEqual(DELIVERY_ENVELOPE_BUDGET);
    const last = text.charCodeAt(text.length - 1);
    expect(last < 0xd800 || last > 0xdbff).toBe(true);
    if (fixedOmitted) expect(text).toContain("[fixed sections truncated]");
    if (previewOmitted) expect(text).toContain(sections.truncationMarker ?? "[truncated]");
  }
});

test("required markers are the absolute floor at tiny budgets", () => {
  const fixedMarker = "[fixed sections truncated]";
  const truncationMarker = "[truncated]";
  const markerFloor = `${fixedMarker}\n${truncationMarker}`;
  const sections = {
    header: ["Header"],
    recovery: ["recovery ".repeat(20)],
    artifacts: ["Artifact: /runs/tiny/events.jsonl"],
    resultPreview: "oversized result",
    truncationMarker,
  };

  expect(buildDeliveryEnvelope(sections, markerFloor.length)).toBe(markerFloor);
  expect(buildDeliveryEnvelope({ header: ["Header".repeat(20)] }, fixedMarker.length)).toBe(fixedMarker);
  expect(buildDeliveryEnvelope({ header: [], resultPreview: "oversized result", truncationMarker }, truncationMarker.length)).toBe(truncationMarker);

  for (const budget of [1, fixedMarker.length, markerFloor.length - 1]) {
    const text = buildDeliveryEnvelope(sections, budget);
    expect(text.length).toBeLessThanOrEqual(budget);
    const last = text.charCodeAt(text.length - 1);
    expect(last < 0xd800 || last > 0xdbff).toBe(true);
  }
});

test("fixed overflow preserves recovery and artifacts before cutting failures", () => {
  const recovery = 'Recovery: workflow({ scriptPath: "/runs/overflow/script.js", resumeRunId: "overflow" })';
  const artifact = "Result artifact: /runs/overflow/events.jsonl";
  const failures = Array.from({ length: 10 }, (_, index) => `failure-${index}:${"f".repeat(1_490)}`);
  const text = buildDeliveryEnvelope({
    header: [`Workflow run overflow ${"h".repeat(1_000)}`],
    failures,
    recovery: [recovery],
    artifacts: [artifact],
    warnings: ["Warning: optional"],
  });

  expect(text.length).toBeLessThanOrEqual(DELIVERY_ENVELOPE_BUDGET);
  expect(text).toContain(recovery);
  expect(text).toContain(artifact);
  expect(text).toContain("[fixed sections truncated]");
  expect(text).not.toContain(failures.at(-1)!);
});

test("delivery preview truncation never leaves an unpaired high surrogate", () => {
  const marker = "[truncated]";
  const fixed = "Header\nResult preview:";
  const budget = fixed.length + marker.length + 4;
  const text = buildDeliveryEnvelope({
    header: ["Header"],
    resultPreview: `a😀${"tail".repeat(20)}`,
    truncationMarker: marker,
  }, budget);

  expect(text).toBe(`${fixed}\na\n${marker}`);
  expect([...text].some((character) => {
    const code = character.charCodeAt(0);
    return code >= 0xd800 && code <= 0xdbff;
  })).toBe(false);
});

test("workflow failure delivery includes an exact resume invocation", () => {
  const text = formatWorkflowFailure(new WorkflowRunError("child failed", "workflow-1", "/runs/workflow-1"));
  expect(text).toContain("Error: child failed");
  expect(text).toContain('workflow({ scriptPath: "/runs/workflow-1/script.js", resumeRunId: "workflow-1" })');
});

test("workflow abort formatting does not advertise recovery", () => {
  const text = formatWorkflowFailure(new WorkflowRunError(
    "Workflow stopped",
    "workflow-1",
    "/runs/workflow-1",
    undefined,
    [],
    1,
    "aborted",
  ));
  expect(text).toContain("Status: aborted");
  expect(text).toContain("intentionally stopped");
  expect(text).not.toContain("Error:");
  expect(text).not.toContain("Recovery:");
  expect(text).not.toContain("resumeRunId");
});

test("workflow failure carries failed-child errors and the null-result hint", () => {
  const failed = [{
    id: "child-9",
    status: "failed" as const,
    text: "",
    error: 'Invalid model "gpt-5.6-terra". Expected provider/model-id',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    resolved: { provider: "test", modelId: "test", thinkingLevel: "off" as const, tools: [], cwd: "/work", label: "discover" },
  }];
  const text = formatWorkflowFailure(new WorkflowRunError("Cannot read properties of null (reading 'sources')", "workflow-2", "/runs/workflow-2", undefined, failed));
  expect(text).toContain("1 failed child (discover): Invalid model");
  expect(text).toContain("resolves to null");
  expect(text).toContain('resumeRunId: "workflow-2"');
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
