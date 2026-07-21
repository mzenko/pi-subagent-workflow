import { expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerWorkflowTool, workflowSummaryLines, workflowToolDetails, type WorkflowToolDetails } from "../src/workflow/workflow-tool.ts";
import type { WorkflowRunResult } from "../src/workflow/workflow-runner.js";

function result(overrides: Partial<Record<string, unknown>> = {}): WorkflowRunResult {
  return {
    runId: "run-1",
    runDir: "/tmp/run-1",
    meta: { name: "atlas", description: "d", phases: [{ title: "Research" }, { title: "Build" }] },
    result: { countries: Array.from({ length: 40 }, (_, index) => ({ index, blurb: "x".repeat(50) })) },
    failedChildren: [],
    ...overrides,
  } as unknown as WorkflowRunResult;
}

function unsafeDetails(): WorkflowToolDetails {
  const ESC = "\u001b";
  return {
    status: "completed",
    runId: `run${ESC}[2J-1\nforged`,
    runDir: `/tmp/${ESC}Psecret${ESC}\\run\u009b`,
    phases: [
      { title: "Re\u009b31md\nphase" },
      { title: `Ship${ESC}]0;owned\u0007now` },
    ],
    resultPreview: `ok${ESC}]8;;https://evil\u0007link${ESC}]8;;\u0007${ESC}[`,
    resultBytes: 999,
    failureGroups: [{
      count: 3,
      labels: ["child\none", "child\u009d0;bad\u009ctwo"],
      error: `b${ESC}[31moom\u0085again`,
    }],
    persistenceWarning: `disk${ESC}]0;still open`,
  };
}

function workflowResultRenderer(): NonNullable<ToolDefinition<any, any, any>["renderResult"]> {
  let registered: ToolDefinition<any, any, any> | undefined;
  const pi = {
    registerTool: (tool: ToolDefinition<any, any, any>) => { registered = tool; },
  } as unknown as ExtensionAPI;
  registerWorkflowTool(pi, "/extension.ts", {} as never);
  return registered!.renderResult!;
}

test("workflow tool guidance describes safe orchestration and delivery defaults", () => {
  let registered: ToolDefinition<any, any, any> | undefined;
  const pi = {
    registerTool: (tool: ToolDefinition<any, any, any>) => { registered = tool; },
  } as unknown as ExtensionAPI;

  registerWorkflowTool(pi, "/extension.ts", {} as never);

  expect(registered!.description).toContain("required: ['files']");
  expect(registered!.description).toContain("result?.files.filter(Boolean) ?? []");
  expect(registered!.description).toContain("A resumeRunId still requires exactly one of script or scriptPath");
  expect(registered!.description).toContain("Every prompt must be self-contained");
  expect(registered!.description).toContain("the patch is never applied automatically");
  expect(registered!.description).toContain("in the background by default");
  expect(registered!.description).toContain('{ type: "workflow_result", runId, runDir, status, result }');
  expect(registered!.description).toContain("workflow-authoring skill");
  expect(registered!.description).not.toContain("advisory budget");
  // The long-form authoring guidance lives in the skill, not the per-call tax.
  expect(registered!.description.length).toBeLessThan(2600);
  const properties = (registered!.parameters as {
    properties: Record<string, { description?: string }>;
  }).properties;
  expect(properties).not.toHaveProperty("budget");
  expect(properties.wait?.description).toContain("Waiting blocks the rest of this turn until the workflow finishes");
  expect(properties.wait?.description).toContain("the user's only recourse is /background or b in /agents");
  expect(properties.wait?.description).toContain("returns a backgrounded running result - after that, do not poll");
  expect(properties.args?.description).toContain("On resume, omit to reuse persisted args");
  expect(properties.rerunChildIds?.description).toContain("execution-environment drift");
  expect(registered!.description).not.toMatch(/follow.?up|warm|restart/i);
});

test("the tool row renders a bounded summary instead of the full result JSON", () => {
  const details = workflowToolDetails(result());
  expect(details.resultPreview!.length).toBeLessThanOrEqual(200);
  expect(details.resultBytes).toBeGreaterThan(1000);
  const lines = workflowSummaryLines(details);
  expect(lines[0]).toBe("run-1 - completed");
  expect(lines).toContain("phases: Research, Build");
  const rendered = lines.join("\n");
  expect(rendered.length).toBeLessThan(700);
  expect(rendered).toContain("[preview of");
  expect(rendered).toContain("run dir: /tmp/run-1");
});

test("failure groups render one line per distinct error", () => {
  const failed = ["France", "Sweden", "Austria", "Malta"].map((label, index) => ({
    id: `c${index}`, status: "failed", text: "", error: "Model not found: anthropic/claude-5-sonnet.",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    resolved: { provider: "unknown", modelId: "unknown", thinkingLevel: "off", tools: [], cwd: "/tmp", label },
  }));
  const lines = workflowSummaryLines(workflowToolDetails(result({ failedChildren: failed, result: undefined })));
  const failures = lines.filter((line) => line.includes("Model not found"));
  expect(failures).toEqual(["4 failed (France, Sweden, Austria, ...): Model not found: anthropic/claude-5-sonnet."]);
});

test("workflowSummaryLines sanitizes every dynamic terminal field independently", () => {
  expect(workflowSummaryLines(unsafeDetails())).toEqual([
    "run-1forged - completed",
    "phases: Redphase, Shipnow",
    "result: oklink [preview of 999 bytes]",
    "3 failed (childone, childtwo, ...): boomagain",
    "warning: disk",
    "run dir: /tmp/run",
  ]);
});

test("the rendered workflow component preserves theme ANSI after sanitizing and truncates to width", () => {
  const styledInputs: string[] = [];
  const theme = {
    fg: (_color: string, text: string) => {
      styledInputs.push(text);
      return `\u001b[2m${text}\u001b[22m`;
    },
    bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  };
  const renderer = workflowResultRenderer();
  const component = renderer(
    { content: [], details: unsafeDetails() },
    { expanded: true, isPartial: false },
    theme as never,
    {} as never,
  );
  const width = 32;
  const lines = component.render(width);

  expect(styledInputs).toEqual(workflowSummaryLines(unsafeDetails()).slice(1));
  expect(lines).toHaveLength(6);
  expect(lines.join("\n")).toContain("\u001b[2m");
  expect(lines.join("\n")).not.toContain("\u001b[31m");
  expect(lines.join("\n")).not.toContain("\u001b]");
  expect(lines.join("\n")).not.toMatch(/[\u0080-\u009f]/);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});

test("the detail-less workflow renderer shares sanitizer state across adjacent text parts", () => {
  const ESC = "\u001b";
  const renderer = workflowResultRenderer();
  const component = renderer(
    {
      content: [
        { type: "text", text: `safe\nstyle${ESC}` },
        { type: "text", text: `[31mred\nosc${ESC}]0;` },
        { type: "text", text: "title\nhidden" },
        { type: "text", text: "\u0007tail\nc1\u009b" },
        { type: "text", text: `31mred\nincomplete${ESC}` },
        { type: "text", text: "[" },
      ],
      details: undefined,
    },
    { expanded: true, isPartial: false },
    { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
    {} as never,
  );

  expect(component.render(80)).toEqual(["safe", "stylered", "osctail", "c1red", "incomplete"]);
});
