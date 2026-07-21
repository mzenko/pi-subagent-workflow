import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PLAIN } from "../src/ui/format.js";
import { bodyHeight, clampScroll, scriptOverlayLines } from "../src/ui/script-overlay.js";

test("clampScroll keeps the window within bounds", () => {
  expect(clampScroll(-5, 100, 10)).toBe(0);
  expect(clampScroll(200, 100, 10)).toBe(90);
  expect(clampScroll(5, 100, 10)).toBe(5);
  // Content shorter than the window never scrolls.
  expect(clampScroll(3, 4, 10)).toBe(0);
});

test("overlay renders exactly `height` rows with numbered, width-clamped body", () => {
  const script = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join("\n");
  const height = 12;
  const lines = scriptOverlayLines(script, 0, height, 40, PLAIN);
  expect(lines).toHaveLength(height);
  // Header, then body starting at line 1, then footer.
  expect(lines[0]).toContain("50 lines");
  expect(lines[1]).toContain("1  line-1");
  expect(lines.at(-1)).toContain(`lines 1-${bodyHeight(height)} of 50`);
  expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
});

test("scrolling shows a later window and pads a short tail to full height", () => {
  const script = Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join("\n");
  const height = 8; // body window = 6
  const lines = scriptOverlayLines(script, 100, height, 60, PLAIN);
  expect(lines).toHaveLength(height);
  // clamped to bottom: 12 lines, window 6 -> top index 6 (line 7).
  expect(lines[1]).toContain("7  L7");
  expect(lines.at(-1)).toContain("lines 7-12 of 12");
});

test("overlay strips terminal controls embedded in workflow source", () => {
  const lines = scriptOverlayLines("const safe = '\u001b[2Jtext'\n// end\u0007", 0, 6, 80, PLAIN);
  expect(lines.join("\n")).toContain("const safe = 'text'");
  expect(lines.join("\n")).not.toContain("\u001b");
  expect(lines.join("\n")).not.toContain("\u0007");
});
