import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PLAIN } from "../src/ui/format.js";
import { renderRunCompleted, renderRunStarted } from "../src/ui/entry-markers.js";
import type { UsageSummary } from "../src/types.js";

const usage = (input: number, output: number): UsageSummary => ({ input, output, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });

test("run-started renders one dim line naming the agents", () => {
  const [line] = renderRunStarted({ runId: "run-7", runDir: "/d", childIds: ["c1", "c2"], labels: ["build", "test"] }, PLAIN, 200);
  expect(line).toContain("run-7");
  expect(line).toContain("2 agents");
  expect(line).toContain("build, test");
});

test("run-started strips terminal escape sequences from child-authored labels", () => {
  const evil = "safe[2J]0;pwnedtext";
  const [line] = renderRunStarted({ runId: "run-9", runDir: "/d", childIds: ["c1"], labels: [evil] }, PLAIN, 200);
  expect(line).not.toContain("");
  expect(line).not.toContain("");
  expect(line).toContain("safetext");
});

test("run-completed summarizes status, tokens, and duration with per-child glyphs", () => {
  const lines = renderRunCompleted(
    {
      runId: "run-7",
      runDir: "/d",
      perChild: [
        { id: "c1", status: "completed", label: "build" },
        { id: "c2", status: "failed", label: "test" },
      ],
      usageTotals: usage(10_000, 2_345),
      durationMs: 42_000,
    },
    PLAIN,
    200,
  );
  expect(lines[0]).toContain("run-7");
  expect(lines[0]).toContain("1/2 done");
  expect(lines[0]).toContain("1 failed");
  expect(lines[0]).toContain("12.3k tok");
  expect(lines[0]).toContain("42s");
  expect(lines[1]).toContain("✓ build");
  expect(lines[1]).toContain("✗ test");
});

test("marker lines clamp to width", () => {
  const lines = renderRunCompleted(
    { runId: "run-with-a-long-id", runDir: "/d", perChild: [{ id: "c1", status: "completed", label: "x".repeat(80) }], usageTotals: usage(1, 1), durationMs: 1_000 },
    PLAIN,
    40,
  );
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
});
