import { expect, test } from "bun:test";
import {
  childLabel,
  countStatuses,
  firstLine,
  formatDuration,
  formatTokens,
  PLAIN,
  shortModel,
  SPINNER,
  spinnerFrame,
  statusColor,
  statusGlyph,
} from "../src/ui/format.js";

test("spinnerFrame advances with the clock and stays in range", () => {
  expect(spinnerFrame(0)).toBe(SPINNER[0]);
  expect(spinnerFrame(100)).toBe(SPINNER[1]);
  expect(spinnerFrame(100 * SPINNER.length)).toBe(SPINNER[0]);
});

test("statusColor maps each lifecycle state to a theme role", () => {
  expect(statusColor("completed")).toBe("success");
  expect(statusColor("failed")).toBe("error");
  expect(statusColor("aborted")).toBe("warning");
  expect(statusColor("running")).toBe("accent");
  expect(statusColor("pending")).toBe("dim");
});

test("statusGlyph animates running only when requested", () => {
  expect(statusGlyph("running", PLAIN, 0, true)).toBe(SPINNER[0]);
  expect(statusGlyph("running", PLAIN, 0, false)).toBe("◆");
  expect(statusGlyph("completed", PLAIN, 0, false)).toBe("✓");
  expect(statusGlyph("failed", PLAIN, 0, false)).toBe("✗");
  expect(statusGlyph("aborted", PLAIN, 0, false)).toBe("⊘");
  expect(statusGlyph("pending", PLAIN, 0, false)).toBe("·");
});

test("formatTokens is compact", () => {
  expect(formatTokens(0)).toBe("0");
  expect(formatTokens(940)).toBe("940");
  expect(formatTokens(12_345)).toBe("12.3k");
  expect(formatTokens(2_500_000)).toBe("2.5M");
});

test("formatDuration scales units", () => {
  expect(formatDuration(3_400)).toBe("3.4s");
  expect(formatDuration(42_000)).toBe("42s");
  expect(formatDuration(200_000)).toBe("3m20s");
});

test("shortModel drops the provider prefix", () => {
  expect(shortModel("openai-codex/gpt-5.6-sol")).toBe("gpt-5.6-sol");
  expect(shortModel("sonnet")).toBe("sonnet");
  expect(shortModel(undefined)).toBe("");
});

test("childLabel prefers explicit label then trimmed prompt", () => {
  expect(childLabel({ label: "  Build  ", prompt: "x" })).toBe("Build");
  expect(childLabel({ prompt: "  do   the   thing  " })).toBe("do the thing");
});

test("firstLine returns the first non-empty line", () => {
  expect(firstLine("\n\n  hello \nworld")).toBe("hello");
  expect(firstLine("   ")).toBe("");
});

test("countStatuses aggregates buckets and activity", () => {
  const counts = countStatuses(["running", "pending", "completed", "failed", "aborted", "completed"]);
  expect(counts.total).toBe(6);
  expect(counts.running).toBe(1);
  expect(counts.pending).toBe(1);
  expect(counts.completed).toBe(2);
  expect(counts.failed).toBe(1);
  expect(counts.aborted).toBe(1);
  expect(counts.done).toBe(4);
  expect(counts.active).toBe(true);
  expect(countStatuses(["completed", "failed"]).active).toBe(false);
});
