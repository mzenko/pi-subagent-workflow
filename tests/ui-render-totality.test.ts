/**
 * Renderers must be total.
 *
 * Pi calls a result renderer's `render(width)` synchronously from inside the TUI
 * render loop. Pi guards the renderResult *call* but not the returned
 * component's render, so a throw there is an uncaughtException that kills the
 * whole TUI - and because tool-result details and custom entry data are
 * persisted in the session JSONL, the same value crashes again on every resume.
 * A user hit exactly that: a rejected `subagent` followUp call produced a truthy
 * `details: {}`, `details.children.length` threw, and the session could only be
 * recovered by hand-editing the transcript.
 */

import { expect, spyOn, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as diagnostics from "../src/diagnostics.js";
import { PLAIN } from "../src/ui/format.js";
import { guardedLines } from "../src/ui/component.js";
import { renderSubagentResult, safeDetails } from "../src/ui/tool-render.js";
import { isWorkflowDetails, workflowSummaryLines, type WorkflowToolDetails } from "../src/workflow/workflow-tool.js";
import { renderRunCompleted, renderRunStarted } from "../src/ui/entry-markers.js";

// The shape pi hands back for a call this tool rejected: error text, and a
// truthy but empty `details`. Reading `.children.length` on that is what killed
// the TUI, and because the result is persisted it killed every resume after it.
const REJECTED = {
  content: [{ type: "text", text: "With followUp, tools is invalid at the top level" }],
  details: {},
};

test("a rejected subagent call renders its error instead of crashing the TUI", () => {
  const component = renderSubagentResult(REJECTED, PLAIN, undefined);
  const lines = component.render(120);
  expect(lines.join("\n")).toContain("With followUp, tools is invalid at the top level");
});

test("safeDetails rejects every payload shape that is not drawable rows", () => {
  expect(safeDetails(undefined)).toBeUndefined();
  expect(safeDetails({})).toBeUndefined();
  expect(safeDetails({ children: [] })).toBeUndefined();
  expect(safeDetails({ children: "nope" })).toBeUndefined();
  expect(safeDetails({ children: null })).toBeUndefined();
  expect(safeDetails("string")).toBeUndefined();
});

test("safeDetails fills in a malformed child but drops a non-object entry", () => {
  // A partially written or cross-version child still gets its row, because losing
  // the row would hide that a child exists at all. An entry that is not an object
  // carries nothing to show, so it goes.
  const normalized = safeDetails({
    children: [{}, { id: "c2", label: 7, modelId: 9 }, "junk", null],
  });
  expect(normalized?.children.length).toBe(2);
  expect(normalized?.children[0]).toMatchObject({ id: "child-0", label: "", modelId: "" });
  expect(normalized?.children[1]).toMatchObject({ id: "c2", label: "", modelId: "" });
});

test("subagent rows survive a details payload full of wrong types", () => {
  const component = renderSubagentResult(
    { content: [], details: { children: [{ id: 1, status: {}, label: null, thinking: 4 }] } },
    PLAIN,
    undefined,
  );
  expect(() => component.render(80)).not.toThrow();
});

test("guardedLines degrades a throwing renderer to a notice", () => {
  const draw = guardedLines("test view", () => { throw new Error("boom"); });
  expect(draw(80)).toEqual(["[subagent-workflow] render failed"]);
});

test("the fallback notice never exceeds the width it was given", () => {
  // pi-tui aborts the process on any line wider than the terminal, from inside its
  // paint and after it has stopped the terminal, where nothing here can catch it.
  // An unclamped notice would turn every guarded throw into exactly the crash the
  // guard exists to prevent, on any terminal narrower than the message.
  const draw = guardedLines("a deliberately long view name that dwarfs a narrow terminal", () => {
    throw new Error("boom");
  });
  for (const width of [1, 2, 5, 10, 20, 33, 40, 62, 80, 200]) {
    for (const line of draw(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

test("a throwing renderer is reported once, not once per frame", () => {
  // The render loop repaints continuously, so reporting every frame would fill the
  // diagnostics log and rotate away the informative first occurrence.
  const reported: string[] = [];
  const log = spyOn(diagnostics, "reportDiagnostic").mockImplementation((message) => { reported.push(message); });
  try {
    let message = "boom";
    const draw = guardedLines("test view", () => { throw new Error(message); });
    draw(80); draw(80); draw(80);
    expect(reported.length).toBe(1);
    // A genuinely different failure is still worth a line.
    message = "different";
    draw(80); draw(80);
    expect(reported.length).toBe(2);
  } finally {
    log.mockRestore();
  }
});

test("a rejected workflow call is not mistaken for a run", () => {
  expect(isWorkflowDetails({})).toBe(false);
  expect(isWorkflowDetails(undefined)).toBe(false);
  expect(isWorkflowDetails({ runId: "r", runDir: "/d" })).toBe(true);
});

test("workflowSummaryLines tolerates absent or wrong-typed collections", () => {
  // Only the collection-level checks are contractual. These lines are built
  // eagerly in renderResult, which pi wraps in its own try/catch, so a malformed
  // *entry* inside failureGroups degrades to pi's fallback rather than killing the
  // TUI - not worth guarding field by field. The subagent rows are different: they
  // are built lazily in render(), which pi does not guard.
  const base = { status: "completed", runId: "run-1", runDir: "/d" } as unknown as WorkflowToolDetails;
  expect(() => workflowSummaryLines(base)).not.toThrow();
  const wrongTypes = { ...base, phases: "x", failureGroups: "y" } as unknown as WorkflowToolDetails;
  expect(() => workflowSummaryLines(wrongTypes)).not.toThrow();
});

test("entry markers tolerate malformed persisted data", () => {
  // These come straight off the session JSONL, so a truncated write or an entry
  // from a different version of this extension arrives with any shape at all.
  expect(() => renderRunStarted({ runId: "r", runDir: "/d", labels: "oops" } as never, PLAIN, 120)).not.toThrow();
  expect(() => renderRunStarted({ runId: "r", runDir: "/d", phases: [null] } as never, PLAIN, 120)).not.toThrow();
  expect(() => renderRunCompleted({ runId: "r", runDir: "/d", perChild: "oops", usageTotals: {} } as never, PLAIN, 120)).not.toThrow();
  expect(() => renderRunCompleted({ runId: "r", runDir: "/d", perChild: [null], usageTotals: {} } as never, PLAIN, 120)).not.toThrow();
});
