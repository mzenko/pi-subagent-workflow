import { describe, expect, test } from "bun:test";
import type { TUI } from "@earendil-works/pi-tui";
import { blankImageAnchorsAbovePanel, suppressInlineImages } from "../src/ui/suppress-inline-images.js";

const ESC = String.fromCharCode(0x1b);
const KITTY_LINE = `${ESC}_Ga=T,f=100,q=2,C=1,c=6,r=3,i=4242;QUFBQQ==${ESC}\\`;
const ITERM2_LINE = `${ESC}]1337;File=inline=1:QUFBQQ==${ESC}\\`;

/**
 * Verbatim replica of pi v0.84.0's createInteractiveTuiReference
 * (interactive-mode.ts:351): property reads return fresh forwarding closures
 * that re-resolve the current method at call time; set forwards; there are no
 * deleteProperty or getOwnPropertyDescriptor traps.
 */
function createInteractiveTuiReference(getTui: () => object): TUI {
  return new Proxy({} as TUI, {
    get: (_target, property) => {
      const tui = getTui();
      const value = Reflect.get(tui, property, tui);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const current = getTui();
        const method = Reflect.get(current, property, current);
        if (typeof method !== "function") throw new TypeError(`TUI property ${String(property)} is not callable`);
        return Reflect.apply(method, current, args);
      };
    },
    set: (_target, property, value) => {
      const tui = getTui();
      return Reflect.set(tui, property, value, tui);
    },
    has: (_target, property) => Reflect.has(getTui(), property),
    getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
  });
}

interface Fake {
  renderer: { compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] };
  tui: TUI;
  renders: () => number;
  setOverlay: (up: boolean) => void;
  /** The lines pi-tui's real compositeOverlays was handed on its last call. */
  composited: () => string[] | undefined;
}

/** A prototype-method compositeOverlays, like the real TUI class method. */
function fakeRenderer(): Omit<Fake, "tui"> & { instance: object } {
  let renders = 0;
  let overlay = true;
  let composited: string[] | undefined;
  class Base {
    compositeOverlays(lines: string[], _termWidth: number, _termHeight: number): string[] {
      composited = lines;
      return [...lines];
    }
    requestRender(): void { renders += 1; }
    hasOverlay(): boolean { return overlay; }
  }
  const instance = new Base();
  return {
    renderer: instance,
    instance,
    renders: () => renders,
    setOverlay: (up: boolean) => { overlay = up; },
    composited: () => composited,
  };
}

/** Both shapes pi has handed to ctx.ui.custom factories across versions. */
const HOSTS: Array<[string, () => Fake]> = [
  ["raw TUI (pi <= 0.83)", () => {
    const fake = fakeRenderer();
    return { ...fake, tui: fake.instance as unknown as TUI };
  }],
  ["stable proxy (pi >= 0.84)", () => {
    const fake = fakeRenderer();
    return { ...fake, tui: createInteractiveTuiReference(() => fake.instance) };
  }],
];

for (const [host, make] of HOSTS) {
  test(`[${host}] viewport image lines are blanked while suppressed and restored on dispose`, () => {
    const lines = ["text", KITTY_LINE, "", ITERM2_LINE, "more"];
    const fake = make();

    const restore = suppressInlineImages(fake.tui);
    // pi's render loop invokes the REAL renderer's method, not the reference.
    expect(fake.renderer.compositeOverlays(lines, 80, 24)).toEqual(["text", "", "", "", "more"]);
    // The real compositor receives the blanked frame; the caller's array is not mutated.
    expect(fake.composited()).toEqual(["text", "", "", "", "more"]);
    expect(lines[1]).toBe(KITTY_LINE);

    restore();
    expect(fake.renderer.compositeOverlays(lines, 80, 24)).toEqual(lines);
    // Restoring requests the render pass that re-places the image.
    expect(fake.renders()).toBe(1);
    // Disposing twice is a no-op.
    restore();
    expect(fake.renders()).toBe(1);
  });

  test(`[${host}] repeated open/close cycles neither recurse nor stack wrappers`, () => {
    const fake = make();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const restore = suppressInlineImages(fake.tui);
      expect(fake.renderer.compositeOverlays([KITTY_LINE], 80, 24)).toEqual([""]);
      restore();
    }
    expect(fake.renderer.compositeOverlays([KITTY_LINE], 80, 24)).toEqual([KITTY_LINE]);
  });

  test(`[${host}] overlapping overlays share one refcounted patch`, () => {
    const fake = make();

    const first = suppressInlineImages(fake.tui);
    const second = suppressInlineImages(fake.tui);
    first();
    // Still suppressed: the second overlay is mounted.
    expect(fake.renderer.compositeOverlays([KITTY_LINE], 80, 24)).toEqual([""]);
    expect(fake.renders()).toBe(0);
    second();
    expect(fake.renderer.compositeOverlays([KITTY_LINE], 80, 24)).toEqual([KITTY_LINE]);
    expect(fake.renders()).toBe(1);
  });

  test(`[${host}] a patch orphaned by host teardown self-heals once no overlay is mounted`, () => {
    // pi's own teardown (/reload, session invalidation) hides overlays without
    // running component dispose, so the disposer never fires. The wrapper must
    // stop suppressing on its own once hasOverlay() goes false.
    const fake = make();

    suppressInlineImages(fake.tui); // disposer intentionally dropped
    expect(fake.renderer.compositeOverlays([KITTY_LINE], 80, 24)).toEqual([""]);
    fake.setOverlay(false);
    expect(fake.renderer.compositeOverlays([KITTY_LINE], 80, 24)).toEqual([KITTY_LINE]);
  });
}

test("a fullscreen (alt-screen) host is patched too: its whole screen is the viewport", () => {
  // The default since pi 1.0. TuiAltScreen never calls render(), but it does
  // composite overlays through the inherited TUI method with screen lines.
  const fake = fakeRenderer();
  const host = Object.assign(fake.instance, { mode: "fullscreen" }) as unknown as TUI;
  const screen = [KITTY_LINE, "", "", "caption", ITERM2_LINE, "editor"];

  const restore = suppressInlineImages(host);
  expect(fake.renderer.compositeOverlays(screen, 80, screen.length)).toEqual(["", "", "", "caption", "", "editor"]);
  restore();
  expect(fake.renderer.compositeOverlays(screen, 80, screen.length)).toEqual(screen);
});

describe("images anchored above the regular-mode viewport", () => {
  const history = Array.from({ length: 30 }, (_, index) => `history ${index}`);
  const kitty = (rows: number) => `${ESC}_Ga=T,f=100,q=2,C=1,c=6,r=${rows},i=7;QUFBQQ==${ESC}\\`;
  /** What pi-tui hands back: the panel composited from `top` rows below the viewport top. */
  const composite = (lines: string[], height: number, top: number) => {
    const out = [...lines];
    const start = Math.max(0, out.length - height);
    for (let row = start + top; row < out.length; row += 1) out[row] = "PANEL";
    return out;
  };
  const run = (lines: string[], top = 1) => blankImageAnchorsAbovePanel(lines, composite(lines, 10, top), 10);

  test("a Kitty image whose rows reach under the panel is blanked", () => {
    // Anchor two rows above a 10-row viewport, five rows tall: rows 1-2 of the
    // viewport are image rows, and the panel starts at viewport row 1.
    const lines = [...history, kitty(5), "", "", "", "", ...Array(6).fill("tail")];
    const out = run(lines);
    expect(out[30]).toBe("");
    expect(out.slice(0, 30)).toEqual(history);
  });

  test("a Kitty image that reaches only the margin above the panel is left alone", () => {
    // Rows end on viewport row 0 (the margin); the panel starts at row 1. pi
    // forces no redraw here, so blanking would cost two scrollback rewrites.
    const lines = [...history, kitty(3), "", "", ...Array(9).fill("tail")];
    expect(run(lines)[30]).toBe(kitty(3));
  });

  test("a Kitty image that ends above the viewport is left alone", () => {
    const lines = [...history, kitty(2), "", "", "", "", ...Array(10).fill("tail")];
    expect(run(lines)[30]).toBe(kitty(2));
  });

  test("visible text between the anchor and the panel ends the image block", () => {
    const lines = [...history, kitty(8), "", "a caption", "", ...Array(10).fill("tail")];
    expect(run(lines)[30]).toBe(kitty(8));
  });

  test("an iTerm2 anchor above the viewport is left alone", () => {
    const lines = [...history, ITERM2_LINE, "", "", ...Array(10).fill("tail")];
    expect(run(lines)[30]).toBe(ITERM2_LINE);
  });

  test("an image far above the viewport is left alone", () => {
    const lines = [kitty(5), ...history, ...Array(10).fill("tail")];
    expect(run(lines)[0]).toBe(kitty(5));
  });

  test("a huge declared row count does not scan past the frame", () => {
    // Blank rows run from the anchor to the end of the frame, as when the
    // image is the last thing in the transcript.
    const lines = [...history, kitty(2 ** 31), ...Array(10).fill("")];
    const started = performance.now();
    expect(run(lines)[30]).toBe("");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a frame the overlay did not change is returned as is", () => {
    const lines = [...history, kitty(5), "", "", "", "", ...Array(6).fill("tail")];
    expect(blankImageAnchorsAbovePanel(lines, [...lines], 10)[30]).toBe(kitty(5));
  });
});

test("ordinary text resembling the escape payloads is never blanked", () => {
  // The prefixes include the raw ESC byte, so plain text containing "_G" or
  // "]1337;File=" must pass through untouched.
  const lines = ["my_Graph is ready", "logs at ]1337;File=nope", KITTY_LINE];
  const fake = fakeRenderer();
  const restore = suppressInlineImages(fake.instance as unknown as TUI);
  expect(fake.renderer.compositeOverlays(lines, 80, 24)).toEqual(["my_Graph is ready", "logs at ]1337;File=nope", ""]);
  restore();
});

test("a host without a prototype compositeOverlays method is left untouched", () => {
  let requested = 0;
  const bare = { requestRender: () => { requested += 1; } } as unknown as TUI;
  const restore = suppressInlineImages(bare);
  expect(Object.hasOwn(bare, "compositeOverlays")).toBe(false);
  restore();
  expect(Object.hasOwn(bare, "compositeOverlays")).toBe(false);
  expect(requested).toBe(0);
});
