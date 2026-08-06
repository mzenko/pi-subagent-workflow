import { expect, test } from "bun:test";
import type { TUI } from "@earendil-works/pi-tui";
import { suppressInlineImages } from "../src/ui/suppress-inline-images.js";

const ESC = String.fromCharCode(0x1b);
const KITTY_LINE = `${ESC}_Ga=T,f=100,q=2,C=1,c=6,r=3,i=4242;QUFBQQ==${ESC}\\`;
const ITERM2_LINE = `${ESC}]1337;File=inline=1:QUFBQQ==${ESC}\\`;

interface FakeTui {
  tui: TUI;
  renders: () => number;
  setOverlay: (up: boolean) => void;
}

/** A prototype-method render, like the real TUI's Container.render. */
function fakeTui(lines: string[], rows: number): FakeTui {
  let renders = 0;
  let overlay = true;
  class Base {
    terminal = { rows };
    render(_width: number): string[] { return [...lines]; }
    requestRender(): void { renders += 1; }
    hasOverlay(): boolean { return overlay; }
  }
  return {
    tui: new Base() as unknown as TUI,
    renders: () => renders,
    setOverlay: (up: boolean) => { overlay = up; },
  };
}

test("image lines inside the viewport are blanked while suppressed and restored on dispose", () => {
  const lines = ["text", KITTY_LINE, "", ITERM2_LINE, "more"];
  const { tui, renders } = fakeTui(lines, 24);

  const restore = suppressInlineImages(tui);
  expect(tui.render(80)).toEqual(["text", "", "", "", "more"]);

  restore();
  expect(tui.render(80)).toEqual(lines);
  // Restoring requests the render pass that re-transmits the image, and
  // removes the own-property wrapper outright rather than pinning a bound
  // copy over the prototype method.
  expect(renders()).toBe(1);
  expect(Object.hasOwn(tui, "render")).toBe(false);
  // Disposing twice is a no-op.
  restore();
  expect(renders()).toBe(1);
});

test("repeated open/close cycles do not stack render wrappers", () => {
  const { tui } = fakeTui([KITTY_LINE], 24);
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const restore = suppressInlineImages(tui);
    expect(tui.render(80)).toEqual([""]);
    restore();
  }
  expect(Object.hasOwn(tui, "render")).toBe(false);
  expect(tui.render(80)).toEqual([KITTY_LINE]);
});

test("image lines above the viewport are left alone to avoid the scrollback-erasing full redraw", () => {
  // Blanking a line above the viewport moves firstChanged above the previous
  // viewport top, which sends pi-tui down fullRender(true) - a screen clear
  // that erases scrollback. Only the last terminal.rows lines may change.
  const scrollback = [KITTY_LINE, ...Array.from({ length: 30 }, (_, index) => `history ${index}`)];
  const viewport = [KITTY_LINE, "visible"];
  const { tui } = fakeTui([...scrollback, ...viewport], 10);

  const restore = suppressInlineImages(tui);
  const rendered = tui.render(80);
  expect(rendered[0]).toBe(KITTY_LINE);
  expect(rendered[rendered.length - 2]).toBe("");
  expect(rendered[rendered.length - 1]).toBe("visible");
  restore();
});

test("overlapping overlays share one refcounted patch", () => {
  const { tui, renders } = fakeTui([KITTY_LINE], 24);

  const first = suppressInlineImages(tui);
  const second = suppressInlineImages(tui);
  first();
  // Still suppressed: the second overlay is mounted.
  expect(tui.render(80)).toEqual([""]);
  expect(renders()).toBe(0);
  second();
  expect(tui.render(80)).toEqual([KITTY_LINE]);
  expect(renders()).toBe(1);
});

test("a patch orphaned by host teardown self-heals once no overlay is mounted", () => {
  // pi's own teardown (/reload, session invalidation) hides overlays without
  // running component dispose, so the disposer never fires. The patch must
  // stop suppressing on its own once hasOverlay() goes false.
  const { tui, setOverlay } = fakeTui([KITTY_LINE], 24);

  suppressInlineImages(tui); // disposer intentionally dropped
  expect(tui.render(80)).toEqual([""]);
  setOverlay(false);
  expect(tui.render(80)).toEqual([KITTY_LINE]);
});
