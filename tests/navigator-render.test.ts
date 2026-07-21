import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PLAIN } from "../src/ui/format.js";
import { boxLines, formatPlainSummary } from "../src/ui/navigator/navigator.js";
import { pageRunDetail, renderRunDetail, renderRunList, scrollWindow } from "../src/ui/navigator/render.js";
import type { ChildRow, RunDetail, RunSummary } from "../src/ui/navigator/store-read.js";

const NOW = 1_000_000;

function summary(over: Partial<RunSummary> & { runId: string }): RunSummary {
  return { runDir: `/r/${over.runId}`, kind: "subagent", createdAt: NOW - 5000, label: over.runId, fanout: false, status: "completed", done: 1, total: 1, completed: 1, failed: 0, aborted: 0, tokens: 0, corrupt: false, reconciled: false, ...over };
}

test("renderRunList marks the cursor row and renders corrupt rows dimly, staying within width", () => {
  const rows = [
    summary({ runId: "run-a", label: "Fetcher", status: "running", done: 0, total: 2, tokens: 1500 }),
    summary({ runId: "run-b", corrupt: true, label: "unreadable run" }),
    summary({ runId: "run-c", corrupt: true, label: "quarantined - crashed mid-resume" }),
  ];
  const lines = renderRunList(rows, 0, PLAIN, 60, NOW, 20);
  expect(lines[0]).toContain("Agents");
  expect(lines.some((l) => l.includes("❯ ") && l.includes("Fetcher"))).toBe(true);
  expect(lines.some((l) => l.includes("unreadable run run-b"))).toBe(true);
  expect(lines.some((l) => l.includes("quarantined - crashed mid-resume run-c"))).toBe(true);
  expect(lines.every((l) => visibleWidth(l) <= 60)).toBe(true);
});

test("renderRunList caps output to the line budget with overflow markers", () => {
  const rows = Array.from({ length: 40 }, (_, i) => summary({ runId: `run-${i}` }));
  const lines = renderRunList(rows, 20, PLAIN, 60, NOW, 10);
  expect(lines.length).toBeLessThanOrEqual(10);
  expect(lines.some((l) => l.includes("more"))).toBe(true);
});

test("completed workflows surface failed-child health in list, detail, and plain output", () => {
  const row = summary({
    runId: "mixed-workflow",
    kind: "workflow",
    label: "mixed",
    status: "completed",
    done: 4,
    total: 4,
    completed: 3,
    failed: 1,
  });
  const list = renderRunList([row], 0, PLAIN, 80, NOW, 20).join("\n");
  expect(list).toContain("⚠");
  expect(list).toContain("completed · 3 ok · 1 failed");
  expect(formatPlainSummary([row])).toContain("3 ok · 1 failed");

  const children: ChildRow[] = [
    { id: "ok", label: "ok", model: "test", status: "completed", tokens: 0, spec: { prompt: "ok" } },
    { id: "bad", label: "bad", model: "test", status: "failed", tokens: 0, spec: { prompt: "bad" } },
  ];
  const detail: RunDetail = { runId: row.runId, runDir: row.runDir, kind: "workflow", label: row.label, status: "completed", phases: [], children, narrator: [], hasScript: true, corrupt: false };
  expect(renderRunDetail(detail, 0, "all", PLAIN, 80, NOW, 20).join("\n"))
    .toContain("completed · 1 ok · 1 failed");
});

test("renderRunDetail groups a workflow by phase with agent rows and honors the filter", () => {
  const children: ChildRow[] = [
    { id: "c1", label: "planner", model: "gpt-5.6-sol", phase: "plan", status: "completed", tokens: 100, startedAt: NOW - 3000, endedAt: NOW - 1000, resultLine: "done planning", spec: { prompt: "p" } },
    { id: "c2", label: "builder", model: "gpt-5.6-sol", phase: "build", status: "running", tokens: 40, startedAt: NOW - 2000, activity: "editing file", spec: { prompt: "b" } },
  ];
  const detail: RunDetail = { runId: "w1", runDir: "/w1", kind: "workflow", label: "nightly", status: "running", phases: [{ title: "plan" }, { title: "build" }], children, narrator: [], hasScript: true, corrupt: false };
  const lines = renderRunDetail(detail, 1, "all", PLAIN, 70, NOW, 20);
  const joined = lines.join("\n");
  expect(joined).toContain("nightly");
  expect(joined).toContain("▸ plan");
  expect(joined).toContain("▸ build");
  expect(joined).toContain("planner");
  // cursor is on the second ordered child (builder).
  expect(lines.some((l) => l.includes("❯ ") && l.includes("builder"))).toBe(true);

  const running = renderRunDetail(detail, 0, "running", PLAIN, 70, NOW, 20).join("\n");
  expect(running).toContain("builder");
  expect(running).not.toContain("planner");
  expect(running).toContain("▸ plan");
});

test("renderRunDetail shows every declared workflow phase before agents start", () => {
  const detail: RunDetail = {
    runId: "skeleton",
    runDir: "/skeleton",
    kind: "workflow",
    label: "country research",
    status: "running",
    phases: [{ title: "Research A-N" }, { title: "Research O-Z" }, { title: "Summarize" }],
    children: [{ id: "c1", label: "Austria", model: "test", phase: "Research A-N", status: "running", tokens: 0, spec: { prompt: "x" } }],
    narrator: [],
    hasScript: true,
    corrupt: false,
  };

  const rendered = renderRunDetail(detail, 0, "all", PLAIN, 80, NOW, 20).join("\n");
  expect(rendered).toContain("▸ Research A-N");
  expect(rendered).toContain("▹ Research O-Z");
  expect(rendered).toContain("▹ Summarize");
});

test("renderRunDetail preserves the workflow skeleton when a filter matches no agents", () => {
  const detail: RunDetail = {
    runId: "filtered-skeleton",
    runDir: "/filtered-skeleton",
    kind: "workflow",
    label: "filtered",
    status: "pending",
    phases: [{ title: "Plan" }, { title: "Build" }],
    children: [],
    narrator: [],
    hasScript: true,
    corrupt: false,
  };

  const rendered = renderRunDetail(detail, 0, "failed", PLAIN, 80, NOW, 20).join("\n");
  expect(rendered).toContain("▹ Plan");
  expect(rendered).toContain("▹ Build");
});

test("future workflow phases remain reachable after the last selectable child", () => {
  const phases = Array.from({ length: 20 }, (_, index) => ({ title: `Phase ${index + 1}` }));
  const detail: RunDetail = {
    runId: "long-skeleton",
    runDir: "/long-skeleton",
    kind: "workflow",
    label: "long skeleton",
    status: "running",
    phases,
    children: [{ id: "c1", label: "first", model: "test", phase: "Phase 1", status: "running", tokens: 0, spec: { prompt: "x" } }],
    narrator: [],
    hasScript: true,
    corrupt: false,
  };

  const page = pageRunDetail(detail, 0, "all", 1, 100);
  expect(page.cursor).toBe(0);
  const rendered = renderRunDetail(detail, page.cursor, "all", PLAIN, 80, NOW, 8, page.row).join("\n");
  expect(rendered).toContain("Phase 20");
});

test("narrator logs use the next actual phase transition when a declared phase is skipped", () => {
  const detail: RunDetail = {
    runId: "skipped-phase",
    runDir: "/skipped-phase",
    kind: "workflow",
    label: "skipped phase",
    status: "completed",
    phases: [{ title: "A" }, { title: "B" }, { title: "C" }],
    children: [],
    narrator: [
      { kind: "phase", text: "A", timestamp: 0 },
      { kind: "log", text: "A log", timestamp: 0 },
      { kind: "phase", text: "C", timestamp: 0 },
      { kind: "log", text: "C log", timestamp: 0 },
    ],
    hasScript: true,
    corrupt: false,
  };

  const rendered = renderRunDetail(detail, 0, "all", PLAIN, 80, NOW, 20).join("\n");
  expect(rendered.match(/A log/g)).toHaveLength(1);
  expect(rendered.match(/C log/g)).toHaveLength(1);
});

test("navigator box keeps a fixed rectangular footprint as content height changes", () => {
  const short = boxLines(["one"], "footer", 40, 12, PLAIN);
  const long = boxLines(Array.from({ length: 20 }, (_, index) => `row ${index}`), "footer", 40, 12, PLAIN);

  expect(short).toHaveLength(12);
  expect(long).toHaveLength(12);
  expect(short.every((line) => visibleWidth(line) === 44)).toBe(true);
  expect(long.every((line) => visibleWidth(line) === 44)).toBe(true);
});

test("workflow detail paging counts phase and narrator rows in the viewport", () => {
  const children = Array.from({ length: 4 }, (_, index): ChildRow => ({
    id: `c${index}`,
    label: `child ${index}`,
    model: "test",
    phase: `phase ${index}`,
    status: "completed",
    tokens: 0,
    spec: { prompt: "x" },
  }));
  const phases = children.map((_, index) => ({ title: `phase ${index}` }));
  const narrator = phases.flatMap((phase, index) => [
    { kind: "phase" as const, text: phase.title, timestamp: index * 10 },
    { kind: "log" as const, text: `log ${index}`, timestamp: index * 10 + 1 },
  ]);
  const detail: RunDetail = {
    runId: "paged", runDir: "/paged", kind: "workflow", label: "paged", status: "completed",
    phases, children, narrator, hasScript: true, corrupt: false,
  };

  // Each child consumes three visible rows: phase, log, then agent. Four
  // viewport rows therefore advance to the nearest next child, not four agents.
  expect(pageRunDetail(detail, 0, "all", 1, 4).cursor).toBe(1);
  expect(pageRunDetail(detail, 1, "all", -1, 4).cursor).toBe(0);
});

test("scrollWindow keeps the active row visible and flags overflow", () => {
  expect(scrollWindow(3, 0, 10)).toEqual({ start: 0, count: 3, moreAbove: false, moreBelow: false });
  const win = scrollWindow(100, 50, 10);
  expect(win.start).toBeLessThanOrEqual(50);
  expect(win.start + win.count).toBeGreaterThan(50);
  expect(win.moreAbove).toBe(true);
  expect(win.moreBelow).toBe(true);
});

test("navigator renderers strip terminal controls from child-derived fields", () => {
  const row = summary({ runId: "unsafe", label: "safe\u001b[2Jlabel" });
  const list = renderRunList([row], 0, PLAIN, 60, NOW, 20).join("\n");
  expect(list).toContain("safelabel");
  expect(list).not.toContain("\u001b");

  const child: ChildRow = {
    id: "c1",
    label: "child\u0007",
    model: "model\u001b[2J",
    status: "failed",
    tokens: 0,
    error: "bad\u001b]0;title\u0007news",
    spec: { prompt: "p" },
  };
  const detail: RunDetail = { runId: "r1", runDir: "/r1", kind: "subagent", label: "run", status: "failed", phases: [], children: [child], narrator: [], hasScript: false, corrupt: false };
  const rendered = renderRunDetail(detail, 0, "all", PLAIN, 80, NOW, 20).join("\n");
  expect(rendered).toContain("badnews");
  expect(rendered).not.toContain("\u001b");
  expect(rendered).not.toContain("\u0007");
  expect(rendered).toContain("model");
});

test("plain navigator summary strips terminal controls from run labels", () => {
  const text = formatPlainSummary([summary({ runId: "unsafe\u001b]0;id\u0007", label: "safe\u001b[2Jlabel" })]);
  expect(text).toContain("safelabel");
  expect(text).not.toContain("\u001b");
  expect(text).not.toContain("\u0007");
});
