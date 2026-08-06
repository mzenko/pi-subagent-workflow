import { expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerWorkflowTool, workflowSummaryLines, type WorkflowToolDetails } from "../src/workflow/workflow-tool.ts";

function unsafeDetails(): WorkflowToolDetails {
  const ESC = "\u001b";
  return {
    status: "running",
    runId: `run${ESC}[2J-1\nforged`,
    runDir: `/tmp/${ESC}Psecret${ESC}\\run\u009b`,
    phases: [
      { title: "Re\u009b31md\nphase" },
      { title: `Ship${ESC}]0;owned\u0007now` },
    ],
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

test("workflow tool guidance describes safe orchestration and background delivery", () => {
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
  expect(registered!.description).toContain("Every run is background");
  expect(registered!.description).toContain("do not wait or poll");
  expect(registered!.description).toContain("workflow-authoring skill");
  expect(registered!.description).not.toContain("advisory budget");
  // The long-form authoring guidance lives in the skill, not the per-call tax.
  expect(registered!.description.length).toBeLessThan(2600);
  const properties = (registered!.parameters as {
    properties: Record<string, { description?: string }>;
  }).properties;
  expect(properties).not.toHaveProperty("budget");
  expect(properties).not.toHaveProperty("wait");
  expect(properties.args?.description).toContain("On resume, omit to reuse persisted args");
  expect(properties.rerunChildIds?.description).toContain("execution-environment drift");
  expect(registered!.description).not.toMatch(/follow.?up|warm|restart/i);
});

test("workflowSummaryLines sanitizes every dynamic terminal field independently", () => {
  expect(workflowSummaryLines(unsafeDetails())).toEqual([
    "run-1forged - running",
    "phases: Redphase, Shipnow",
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
  expect(lines).toHaveLength(3);
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
