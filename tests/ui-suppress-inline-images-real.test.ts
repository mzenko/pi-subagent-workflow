/**
 * The image-over-overlay workaround against pi-tui's REAL renderers.
 *
 * The bug this guards came from a seam the fakes could not see: pi's fullscreen
 * renderer (the default since pi 1.0) never called the method the old wrapper
 * patched. These tests drive pi-tui's TuiAltScreen and TuiMainScreen with a
 * terminal that records output and read the Kitty commands each frame sends.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Image, resetCapabilitiesCache, setCapabilities, TuiAltScreen, TuiMainScreen, type Component, type Terminal } from "@earendil-works/pi-tui";
import { suppressInlineImages } from "../src/ui/suppress-inline-images.js";

beforeAll(() => setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true }));
afterAll(() => resetCapabilitiesCache());

const ROWS = 24;

function recordingTerminal(): { terminal: Terminal; take: () => string } {
  let output = "";
  const base: Record<string, unknown> = {
    write: (data: string) => { output += data; },
    columns: 80,
    rows: ROWS,
    kittyProtocolActive: false,
    drainInput: async () => {},
  };
  // Every other Terminal method is a no-op for these frames.
  const terminal = new Proxy(base, { get: (target, key) => (key in target ? target[key as string] : () => {}) }) as unknown as Terminal;
  return { terminal, take: () => { const taken = output; output = ""; return taken; } };
}

const line = (text: string): Component => ({ render: () => [text], invalidate() {} });
/** Shaped like /agents: a bordered box, 90% tall, centered with a margin. */
const PANEL_OPTIONS = { width: "90%", maxHeight: "90%", anchor: "center", margin: 1 } as const;
const panel: Component = {
  render: (width: number) => Array.from({ length: Math.floor(ROWS * 0.9) }, (_, row) => `${row === 0 ? "╭" : "│"}${"PANEL".padEnd(width - 2)}│`),
  invalidate() {},
};

const places = (frame: string): boolean => /\x1b_G[^;\x1b]*a=[Tp]/.test(frame);
const transmits = (frame: string): boolean => /\x1b_G[^;\x1b]*a=T/.test(frame);
const deletes = (frame: string): boolean => /\x1b_G[^;\x1b]*a=d/.test(frame);
const scrollbackRewrites = (frame: string): number => (frame.match(/\x1b\[3J/g) ?? []).length;

type Renderer = TuiAltScreen | TuiMainScreen;

/** Render an image, open the panel over it, repaint, and close it; return each frame. */
function cycle(Kind: new (terminal: Terminal) => Renderer, fix: boolean, trailingLines = 4) {
  const { terminal, take } = recordingTerminal();
  const tui = new Kind(terminal);
  const frame = () => { (tui as unknown as { doRender(): void }).doRender(); return take(); };
  tui.addChild(line("before"));
  tui.addChild(new Image("QUFBQQ==", "image/png", { fallbackColor: (text: string) => text }, { maxHeightCells: 8, maxWidthCells: 20 }, { widthPx: 400, heightPx: 400 }));
  for (let index = 0; index < trailingLines; index += 1) tui.addChild(line(`after ${index}`));
  tui.start();
  const initial = frame();
  const overlay = tui.showOverlay(panel, PANEL_OPTIONS);
  const restore = fix ? suppressInlineImages(tui as never) : () => {};
  const open = frame();
  const repaint = frame();
  restore();
  overlay.hide();
  const closed = frame();
  tui.stop();
  return { initial, open, repaint, closed };
}

const RENDERERS: Array<[string, new (terminal: Terminal) => Renderer]> = [
  ["fullscreen (TuiAltScreen, pi's default)", TuiAltScreen],
  ["regular (TuiMainScreen)", TuiMainScreen],
];

describe.each(RENDERERS)("%s", (_name, Kind) => {
  test("with the workaround the image is removed while the panel is open and restored on close", () => {
    // Baseline: without the workaround pi re-places the image over the open
    // panel. If this stops holding, pi-tui hides covered images itself and
    // suppress-inline-images.ts can be deleted.
    expect(places(cycle(Kind, false).open)).toBe(true);

    const frames = cycle(Kind, true);
    expect(places(frames.initial)).toBe(true);
    expect(deletes(frames.open)).toBe(true);
    expect(places(frames.open)).toBe(false);
    expect(places(frames.repaint)).toBe(false);
    expect(places(frames.closed)).toBe(true);
    // kitty discards the data of an image left without a placement, so a bare
    // re-placement after close would draw nothing: the data must be re-sent.
    expect(transmits(frames.closed)).toBe(true);
  });
});

describe("regular mode, image anchored above the viewport", () => {
  test("an image reaching under the panel is hidden at no extra scrollback cost", () => {
    // 20 trailing lines push the image's anchor above a 24-row viewport while
    // its rows still reach under the panel.
    const without = cycle(TuiMainScreen, false, 20);
    const withFix = cycle(TuiMainScreen, true, 20);
    expect(places(without.open)).toBe(true);
    expect(places(withFix.open) || places(withFix.repaint)).toBe(false);
    expect(scrollbackRewrites(withFix.open) + scrollbackRewrites(withFix.closed))
      .toBe(scrollbackRewrites(without.open) + scrollbackRewrites(without.closed));
  });

  test("an image reaching only the margin above the panel costs no scrollback rewrite", () => {
    const withFix = cycle(TuiMainScreen, true, 23);
    expect(scrollbackRewrites(withFix.open) + scrollbackRewrites(withFix.repaint) + scrollbackRewrites(withFix.closed)).toBe(0);
  });
});
