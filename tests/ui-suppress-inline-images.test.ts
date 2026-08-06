import { expect, test } from "bun:test";
import type { TUI } from "@earendil-works/pi-tui";
import { suppressInlineImages } from "../src/ui/suppress-inline-images.js";

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
  renderer: { render(width: number): string[] };
  tui: TUI;
  renders: () => number;
  setOverlay: (up: boolean) => void;
}

/** A prototype-method render, like the real renderers' Container.render. */
function fakeRenderer(lines: string[], rows: number): Omit<Fake, "tui"> & { instance: object } {
  let renders = 0;
  let overlay = true;
  class Base {
    terminal = { rows };
    render(_width: number): string[] { return [...lines]; }
    requestRender(): void { renders += 1; }
    hasOverlay(): boolean { return overlay; }
  }
  const instance = new Base();
  return {
    renderer: instance,
    instance,
    renders: () => renders,
    setOverlay: (up: boolean) => { overlay = up; },
  };
}

/** Both shapes pi has handed to ctx.ui.custom factories across versions. */
const HOSTS: Array<[string, (lines: string[], rows?: number) => Fake]> = [
  ["raw TUI (pi <= 0.83)", (lines, rows = 24) => {
    const fake = fakeRenderer(lines, rows);
    return { ...fake, tui: fake.instance as unknown as TUI };
  }],
  ["stable proxy (pi >= 0.84)", (lines, rows = 24) => {
    const fake = fakeRenderer(lines, rows);
    return { ...fake, tui: createInteractiveTuiReference(() => fake.instance) };
  }],
];

for (const [host, make] of HOSTS) {
  test(`[${host}] viewport image lines are blanked while suppressed and restored on dispose`, () => {
    const lines = ["text", KITTY_LINE, "", ITERM2_LINE, "more"];
    const fake = make(lines);

    const restore = suppressInlineImages(fake.tui);
    // pi's render loop invokes the REAL renderer's method, not the reference.
    expect(fake.renderer.render(80)).toEqual(["text", "", "", "", "more"]);

    restore();
    expect(fake.renderer.render(80)).toEqual(lines);
    // Restoring requests the render pass that re-transmits the image.
    expect(fake.renders()).toBe(1);
    // Disposing twice is a no-op.
    restore();
    expect(fake.renders()).toBe(1);
  });

  test(`[${host}] repeated open/close cycles neither recurse nor stack wrappers`, () => {
    const fake = make([KITTY_LINE]);
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const restore = suppressInlineImages(fake.tui);
      expect(fake.renderer.render(80)).toEqual([""]);
      restore();
    }
    expect(fake.renderer.render(80)).toEqual([KITTY_LINE]);
  });

  test(`[${host}] overlapping overlays share one refcounted patch`, () => {
    const fake = make([KITTY_LINE]);

    const first = suppressInlineImages(fake.tui);
    const second = suppressInlineImages(fake.tui);
    first();
    // Still suppressed: the second overlay is mounted.
    expect(fake.renderer.render(80)).toEqual([""]);
    expect(fake.renders()).toBe(0);
    second();
    expect(fake.renderer.render(80)).toEqual([KITTY_LINE]);
    expect(fake.renders()).toBe(1);
  });

  test(`[${host}] a patch orphaned by host teardown self-heals once no overlay is mounted`, () => {
    // pi's own teardown (/reload, session invalidation) hides overlays without
    // running component dispose, so the disposer never fires. The wrapper must
    // stop suppressing on its own once hasOverlay() goes false.
    const fake = make([KITTY_LINE]);

    suppressInlineImages(fake.tui); // disposer intentionally dropped
    expect(fake.renderer.render(80)).toEqual([""]);
    fake.setOverlay(false);
    expect(fake.renderer.render(80)).toEqual([KITTY_LINE]);
  });
}

test("image lines above the viewport are left alone to avoid the scrollback-erasing full redraw", () => {
  // Blanking a line above the viewport moves firstChanged above the previous
  // viewport top, which sends pi-tui down fullRender(true) - a screen clear
  // that erases scrollback. Only the last terminal.rows lines may change.
  const scrollback = [KITTY_LINE, ...Array.from({ length: 30 }, (_, index) => `history ${index}`)];
  const fake = fakeRenderer([...scrollback, KITTY_LINE, "visible"], 10);

  const restore = suppressInlineImages(fake.instance as unknown as TUI);
  const rendered = fake.renderer.render(80);
  expect(rendered[0]).toBe(KITTY_LINE);
  expect(rendered[rendered.length - 2]).toBe("");
  expect(rendered[rendered.length - 1]).toBe("visible");
  restore();
});

test("ordinary text resembling the escape payloads is never blanked", () => {
  // The prefixes include the raw ESC byte, so plain text containing "_G" or
  // "]1337;File=" must pass through untouched.
  const lines = ["my_Graph is ready", "logs at ]1337;File=nope", KITTY_LINE];
  const fake = fakeRenderer(lines, 24);
  const restore = suppressInlineImages(fake.instance as unknown as TUI);
  expect(fake.renderer.render(80)).toEqual(["my_Graph is ready", "logs at ]1337;File=nope", ""]);
  restore();
});

test("a host without a prototype render method is left untouched", () => {
  let requested = 0;
  const bare = { requestRender: () => { requested += 1; } } as unknown as TUI;
  const restore = suppressInlineImages(bare);
  expect(Object.hasOwn(bare, "render")).toBe(false);
  restore();
  expect(Object.hasOwn(bare, "render")).toBe(false);
  expect(requested).toBe(0);
});

test("a fullscreen (alt-screen) host is left untouched", () => {
  // TuiAltScreen renders through a layout root, never this.render - a wrapper
  // there would be inert, so none may be installed.
  let requested = 0;
  const fake = fakeRenderer([KITTY_LINE], 24);
  const host = Object.assign(fake.instance, { mode: "fullscreen" }) as unknown as TUI & { requestRender(): void };
  const originalRequest = host.requestRender.bind(host);
  (host as { requestRender(): void }).requestRender = () => { requested += 1; originalRequest(); };

  const restore = suppressInlineImages(host);
  expect(Object.hasOwn(host, "render")).toBe(false);
  expect(fake.renderer.render(80)).toEqual([KITTY_LINE]);
  restore();
  expect(requested).toBe(0);
});
