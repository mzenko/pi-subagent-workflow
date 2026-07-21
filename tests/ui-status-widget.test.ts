import { expect, spyOn, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { countStatuses, PLAIN } from "../src/ui/format.js";
import { renderWidgetLines, statusWidgetRowCap, SubagentStatusWidget, type WidgetRunView } from "../src/ui/status-widget.js";
import type { SubagentEvent, SubagentHandle } from "../src/types.js";

function view(over: Partial<WidgetRunView> & { label: string }): WidgetRunView {
  return {
    counts: countStatuses(["running"]),
    startedAt: 0,
    tokens: 0,
    ...over,
  };
}

test("renderWidgetLines shows a header and one line per active run", () => {
  const lines = renderWidgetLines(
    [
      view({ label: "build docs", counts: countStatuses(["running", "completed"]), tokens: 8_000, startedAt: 0 }),
      view({ label: "fan-out ×3", counts: countStatuses(["running", "running", "pending"]), tokens: 1_500, startedAt: 500 }),
    ],
    PLAIN,
    120,
    10_000,
  );
  expect(lines[0]).toContain("agents");
  expect(lines[0]).toContain("3 running");
  expect(lines[0]).toContain("1 queued");
  expect(lines[1]).toContain("build docs");
  expect(lines[1]).toContain("1/2");
  expect(lines[1]).toContain("8.0k tok");
  expect(lines[2]).toContain("fan-out ×3");
});

test("renderWidgetLines collapses overflow and clamps width", () => {
  const runs = Array.from({ length: 9 }, (_, index) => view({ label: `run ${index}` }));
  const lines = renderWidgetLines(runs, PLAIN, 30, 1_000);
  expect(lines.some((line) => line.includes("+3 more runs"))).toBe(true);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
});

test("status widget row cap follows terminal height with a fixed fallback", () => {
  expect(statusWidgetRowCap(undefined)).toBe(6);
  expect(statusWidgetRowCap(12)).toBe(3);
  expect(statusWidgetRowCap(24)).toBe(6);
  expect(statusWidgetRowCap(40)).toBe(10);
});

test("renderWidgetLines is empty when there are no runs", () => {
  expect(renderWidgetLines([], PLAIN, 80, 0)).toEqual([]);
});

// ---- wiring ----

function fakeHandle(id: string, listeners: Array<(event: SubagentEvent) => void>): { handle: SubagentHandle; setStatus: (s: SubagentHandle["status"]) => void } {
  const handle = {
    id,
    runId: "run-1",
    runDir: "/runs/run-1",
    spec: { prompt: "p", label: id },
    resolved: undefined,
    status: "running" as SubagentHandle["status"],
    startedAt: 0,
    result: Promise.resolve() as never,
    steer: async () => {},
    abort: async () => {},
    subscribe: (listener: (event: SubagentEvent) => void) => {
      listeners.push(listener);
      return () => {};
    },
  } as SubagentHandle;
  return { handle, setStatus: (status) => { (handle as { status: SubagentHandle["status"] }).status = status; } };
}

test("widget registers a belowEditor widget while active and clears it when idle", () => {
  const calls: Array<[string, unknown]> = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (key: string, content: unknown) => calls.push([`widget:${key}`, content]),
      setStatus: (key: string, text: unknown) => calls.push([`status:${key}`, text]),
    },
  } as never;

  const listeners: Array<(event: SubagentEvent) => void> = [];
  const first = fakeHandle("c1", listeners);
  const widget = new SubagentStatusWidget();
  widget.track("run-1", [first.handle], false, ctx);

  const registered = calls.filter(([key, value]) => key === "widget:subagent-workflow" && typeof value === "function");
  expect(registered.length).toBeGreaterThan(0);

  // Complete the only child: the widget should clear.
  first.setStatus("completed");
  for (const listener of listeners) listener({ type: "status", id: "c1", status: "completed" } as SubagentEvent);
  expect(calls.some(([key, value]) => key === "widget:subagent-workflow" && value === undefined)).toBe(true);
  widget.dispose();
});

test("widget is inert without dialog-capable UI", () => {
  let touched = false;
  const ctx = { hasUI: false, ui: { setWidget: () => { touched = true; }, setStatus: () => { touched = true; } } } as never;
  const widget = new SubagentStatusWidget();
  widget.track("run-1", [fakeHandle("c1", []).handle], false, ctx);
  expect(touched).toBe(false);
  widget.dispose();
});

test("widget can be hidden and shown live without losing an active run", () => {
  const calls: Array<[string, unknown]> = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (key: string, content: unknown) => calls.push([`widget:${key}`, content]),
      setStatus: (key: string, text: unknown) => calls.push([`status:${key}`, text]),
    },
  } as never;
  const widget = new SubagentStatusWidget();
  widget.configure(false);
  widget.track("run-1", [fakeHandle("c1", []).handle], false, ctx);
  expect(calls.some(([key, value]) => key === "widget:subagent-workflow" && typeof value === "function")).toBe(false);

  widget.configure(true);
  expect(calls.some(([key, value]) => key === "widget:subagent-workflow" && typeof value === "function")).toBe(true);

  widget.configure(false);
  expect(calls.some(([key, value]) => key === "widget:subagent-workflow" && value === undefined)).toBe(true);
  widget.dispose();
});

test("widget setup failure stops its refresh timer", async () => {
  let widgetCalls = 0;
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: () => { widgetCalls += 1; throw new Error("UI closed"); },
      setStatus: () => {},
    },
  } as never;
  const widget = new SubagentStatusWidget();
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => widget.track("run-1", [fakeHandle("c1", []).handle], false, ctx)).not.toThrow();
    const callsAfterFailure = widgetCalls;
    await Bun.sleep(230);
    expect(widgetCalls).toBe(callsAfterFailure);
  } finally {
    widget.dispose();
    errorLog.mockRestore();
  }
});

test("a workflow row shows its name, current phase position, and progress", () => {
  const lines = renderWidgetLines(
    [view({
      kind: "workflow", label: "country-atlas", phase: "Research (2/3)",
      counts: countStatuses(["running", "running", "completed", "completed", "completed"]), tokens: 45_200, startedAt: 0,
    })],
    PLAIN, 120, 130_000,
  );
  expect(lines[0]).toContain("1 workflow");
  expect(lines[1]).toContain("country-atlas");
  expect(lines[1]).toContain("Research (2/3)");
  expect(lines[1]).toContain("3/5");
  expect(lines[1]).toContain("2m10s");
});

test("a just-started workflow with no children yet renders as starting", () => {
  const lines = renderWidgetLines(
    [view({ kind: "workflow", label: "atlas", counts: countStatuses([]), startedAt: 0 })],
    PLAIN, 120, 1_000,
  );
  expect(lines[1]).toContain("starting");
});

test("workflow rows appear at launch, absorb child spawns, and persist between batches", () => {
  const calls: Array<[string, unknown]> = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (key: string, content: unknown) => calls.push([`widget:${key}`, content]),
      setStatus: (key: string, text: unknown) => calls.push([`status:${key}`, text]),
    },
  } as never;
  let spawnListener: ((run: { runId: string; runDir: string; parentSessionId: string; handles: unknown[] }) => void) | undefined;
  let workflowActive = true;
  const runner = {
    subscribeSpawns: (listener: never) => { spawnListener = listener; return () => {}; },
    isRunActive: () => workflowActive,
  } as never;
  const widget = new SubagentStatusWidget(runner);
  widget.observeWorkflowStarted({ runId: "workflow-1", runDir: "/runs/workflow-1", name: "atlas", phases: [{ title: "Research" }] }, ctx);
  // Row exists before any child spawns.
  expect(calls.some(([key, value]) => key === "widget:subagent-workflow" && typeof value === "function")).toBe(true);

  const listeners: Array<(event: SubagentEvent) => void> = [];
  const child = fakeHandle("c1", listeners);
  (child.handle as { runId: string }).runId = "workflow-1";
  (child.handle.spec as { phase?: string }).phase = "Research";
  spawnListener!({ runId: "workflow-1", runDir: "/runs/workflow-1", parentSessionId: "parent", handles: [child.handle] });

  // Child completes; the workflow row persists because the run controller is live.
  child.setStatus("completed");
  for (const listener of listeners) listener({ type: "status", id: "c1", status: "completed" } as SubagentEvent);
  expect(calls.some(([key, value]) => key === "widget:subagent-workflow" && value === undefined)).toBe(false);

  // Controller unregisters: the next event sweep clears the widget.
  workflowActive = false;
  for (const listener of listeners) listener({ type: "status", id: "c1", status: "completed" } as SubagentEvent);
  expect(calls.some(([key, value]) => key === "widget:subagent-workflow" && value === undefined)).toBe(true);
  widget.dispose();
});
