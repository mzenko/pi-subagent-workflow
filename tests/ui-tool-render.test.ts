import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PLAIN, SPINNER } from "../src/ui/format.js";
import { callHeaderLine, renderRows, type SubagentDetails } from "../src/ui/tool-render.js";

test("call header strips terminal escapes from the label", () => {
  const ESC = "\u001b";
  const BEL = "\u0007";
  // CSI screen-clear, then a BEL-terminated OSC title-set, in an otherwise plain label.
  const label = `run${ESC}[2J${ESC}]0;pwned${BEL}ok`;
  const line = callHeaderLine(label, PLAIN);
  expect(line).not.toContain(ESC);
  expect(line).toContain("subagent · runok");
});

test("renderRows shows the launch receipt row", () => {
  const details: SubagentDetails = {
    children: [{ id: "c1", label: "build", modelId: "gpt-5.6-sol" }],
  };
  const [row] = renderRows(details, PLAIN, 200);
  expect(row).toContain("build");
  expect(row).toContain("gpt-5.6-sol");
});

test("rows carry nothing clock-derived, so an idle tool row never repaints", () => {
  // Pi draws inline and pi-tui falls back to a full redraw - which erases the
  // scrollback - as soon as a changed line sits above the visible viewport. A
  // tool row ends up there the moment the conversation grows past it, so a
  // ticking elapsed or an animated spinner here would wipe the user's scrollback
  // on every render, for the rest of the session.
  const details: SubagentDetails = {
    children: [{ id: "c1", label: "build", modelId: "m" }],
  };
  const lines = renderRows(details, PLAIN, 200);
  for (const frame of SPINNER) expect(lines.join("\n")).not.toContain(frame);
  expect(lines.join("\n")).not.toMatch(/\d+(\.\d)?s/);
});

test("renderRows aligns the model column across a legacy multi-child snapshot", () => {
  // Older sessions persisted several children per call; those snapshots still
  // draw on resume and keep their columns aligned.
  const details: SubagentDetails = {
    children: [
      { id: "c1", label: "a", modelId: "m" },
      { id: "c2", label: "longer-label", modelId: "m" },
    ],
  };
  const lines = renderRows(details, PLAIN, 200);
  expect(lines).toHaveLength(2);
  expect(lines[0]!.indexOf(" m")).toBe(lines[1]!.indexOf(" m"));
});

test("renderRows never exceeds the terminal width", () => {
  const details: SubagentDetails = {
    children: [{ id: "c1", label: "a very long label that should be truncated hard", modelId: "some-model" }],
  };
  for (const line of renderRows(details, PLAIN, 40)) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  }
});

test("renderRows shows reasoning effort beside the model", () => {
  const details: SubagentDetails = {
    children: [
      { id: "c1", label: "audit", modelId: "gpt-5.6-sol", thinking: "high" },
      // "off" is the resting state for non-reasoning models and stays hidden.
      { id: "c2", label: "lint", modelId: "haiku-4-5", thinking: "off" },
    ],
  };
  const [first, second] = renderRows(details, PLAIN, 200);
  expect(first).toContain("gpt-5.6-sol·high");
  expect(second).toContain("haiku-4-5");
  expect(second).not.toContain("off");
});

test("renderRows keeps effort visible when the model id fills the cell", () => {
  const details: SubagentDetails = {
    children: [{ id: "c1", label: "verify", modelId: "claude-opus-4-5-20251101", thinking: "xhigh" }],
  };
  const [row] = renderRows(details, PLAIN, 200);
  expect(row).toContain("·xhigh");
  expect(row).toContain("…");
});
