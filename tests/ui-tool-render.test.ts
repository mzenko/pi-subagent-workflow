import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PLAIN } from "../src/ui/format.js";
import { callHeaderLine, renderRows, SubagentRowTracker, type SubagentDetails } from "../src/ui/tool-render.js";
import type { SubagentEvent, SubagentHandle, UsageSummary } from "../src/types.js";

test("call header strips terminal escapes from the label", () => {
  const ESC = "\u001b";
  const BEL = "\u0007";
  // CSI screen-clear, then a BEL-terminated OSC title-set, in an otherwise plain label.
  const label = `run${ESC}[2J${ESC}]0;pwned${BEL}ok`;
  const line = callHeaderLine({ fanout: false, label }, PLAIN);
  expect(line).not.toContain(ESC);
  expect(line).toContain("subagent \u00b7 runok");
});

const usage = (input: number, output: number): UsageSummary => ({ input, output, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });

function fakeHandle(over: Partial<SubagentHandle> & { id: string }): SubagentHandle {
  return {
    runId: "run-1",
    runDir: "/runs/run-1",
    spec: { prompt: "do a thing" },
    resolved: undefined,
    status: "running",
    startedAt: 0,
    result: Promise.resolve() as never,
    steer: async () => {},
    abort: async () => {},
    subscribe: () => () => {},
    ...over,
  } as SubagentHandle;
}

test("tracker overlays streaming activity/tokens/result onto live handle state", () => {
  const tracker = new SubagentRowTracker(false, () => 5_000);
  const handle = fakeHandle({ id: "c1", spec: { prompt: "p", label: "build" }, resolved: { provider: "openai-codex", modelId: "openai-codex/gpt-5.6-sol", thinkingLevel: "off", tools: [], cwd: "/", label: "build" }, status: "running", startedAt: 1_000 });

  tracker.observe({ type: "activity", id: "c1", description: "bash   {\"cmd\":\"ls\"}" } as SubagentEvent);
  tracker.observe({ type: "usage", id: "c1", usage: usage(100, 40) } as SubagentEvent);
  const snap = tracker.snapshot([handle]);
  expect(snap.children[0]).toMatchObject({ id: "c1", label: "build", modelId: "gpt-5.6-sol", tokens: 140, startedAt: 1_000 });
  expect(snap.children[0]!.activity).toBe('bash {"cmd":"ls"}');

  tracker.observe({ type: "result", id: "c1", result: { id: "c1", status: "completed", text: "All good\nmore", usage: usage(120, 60), resolved: handle.resolved! } } as SubagentEvent);
  const done = tracker.snapshot([{ ...handle, status: "completed" } as SubagentHandle]);
  expect(done.children[0]).toMatchObject({ status: "completed", tokens: 180, resultLine: "All good", endedAt: 5_000 });
});

test("renderRows shows a live running row with all columns", () => {
  const details: SubagentDetails = {
    fanout: false,
    children: [{ id: "c1", label: "build", modelId: "gpt-5.6-sol", status: "running", tokens: 12_345, startedAt: 0, activity: "reading files" }],
  };
  const [row] = renderRows(details, PLAIN, 200, 3_400, true);
  expect(row).toContain("build");
  expect(row).toContain("gpt-5.6-sol");
  expect(row).toContain("3.4s");
  expect(row).toContain("12.3k tok");
  expect(row).toContain("reading files");
});

test("renderRows aligns labels across children and adds a fan-out header", () => {
  const details: SubagentDetails = {
    fanout: true,
    children: [
      { id: "c1", label: "a", modelId: "m", status: "completed", tokens: 10, startedAt: 0, endedAt: 1_000, resultLine: "ok" },
      { id: "c2", label: "longer-label", modelId: "m", status: "failed", tokens: 20, startedAt: 0, endedAt: 2_000, error: "boom" },
    ],
  };
  const lines = renderRows(details, PLAIN, 200, 3_000, false);
  expect(lines[0]).toContain("fan-out");
  expect(lines[0]).toContain("2/2 done");
  expect(lines[0]).toContain("1 failed");
  // The model column starts at the same offset on both rows (labels padded equally).
  expect(lines[1]!.indexOf(" m")).toBe(lines[2]!.indexOf(" m"));
  expect(lines[2]).toContain("boom");
});

test("renderRows folds a large collapsed fan-out into a count", () => {
  const children = Array.from({ length: 12 }, (_, index) => ({ id: `c${index}`, label: `agent ${index}`, modelId: "m", status: "running" as const, tokens: 100, startedAt: 0 }));
  const details: SubagentDetails = { fanout: true, children };
  const collapsed = renderRows(details, PLAIN, 200, 1_000, true, false);
  expect(collapsed.some((line) => line.includes("+4 more (expand to view)"))).toBe(true);
  const expanded = renderRows(details, PLAIN, 200, 1_000, true, true);
  expect(expanded.some((line) => line.includes("more (expand"))).toBe(false);
  expect(expanded.length).toBe(children.length + 1); // header + all rows
});

test("renderRows never exceeds the terminal width", () => {
  const details: SubagentDetails = {
    fanout: false,
    children: [{ id: "c1", label: "a very long label that should be truncated hard", modelId: "some-model", status: "running", tokens: 999, startedAt: 0, activity: "x".repeat(300) }],
  };
  for (const line of renderRows(details, PLAIN, 40, 1_000, true)) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  }
});
