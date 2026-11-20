/**
 * Blank on-screen inline-image lines while one of our overlays is mounted.
 *
 * Why images paint over overlays: pi-tui composites overlays over text lines
 * but deliberately skips image lines (compositeTuiLine returns the base line
 * untouched when it carries an image escape). Kitty graphics placements live
 * on a layer above text (z=0 by default), so Kitty and Ghostty keep drawing
 * the image over any text written into its cells; terminals that store images
 * in cells (WezTerm, Orca) are no better, because pi's fullscreen renderer
 * draws image placements after all text. iTerm2's protocol is cell-based, but
 * the uncomposited anchor row still punches a hole through the panel. Every
 * terminal pi sends images to (Kitty, Ghostty, WezTerm, Warp, Orca, iTerm2)
 * is affected; terminals pi does not send images to (tmux, Alacritty, VS
 * Code, Terminal.app, ...) never see it. Upstream declined to blank covered
 * image blocks itself (pi issue #6995).
 *
 * The seam is TUI.compositeOverlays(lines, termWidth, termHeight). Both pi
 * renderers call it with the frame's lines just before their differential
 * pass: the regular (main-screen) renderer with the whole buffer, the
 * fullscreen (alt-screen, the default since pi 1.0) renderer with the screen.
 * Patching TUI.render instead - the previous approach - only ever worked in
 * regular mode: fullscreen builds its frame through a layout root and never
 * calls render, which is why images kept covering /agents there. Blanking an
 * anchor line makes pi's own pass delete the placement (per-image deletes in
 * regular mode, delete-all-placements plus redraw in fullscreen); unmounting
 * restores the line and pi re-places the image the same way.
 *
 * Which lines are blanked:
 * - Every image line in the visible viewport (the last termHeight lines; the
 *   whole frame in fullscreen). Extensions cannot see overlay geometry, and
 *   the panel covers ~90% of the screen anyway.
 * - In regular mode, a Kitty image whose anchor row scrolled above the
 *   viewport but whose rows reach down under the panel. Its placement would
 *   cover the panel. Blanking a line above the viewport sends pi-tui down a
 *   scrollback-rewriting full redraw, but compositing the panel over that
 *   image's reserved rows already forces exactly that redraw (pi-tui widens
 *   any change touching an image block to the block's anchor), so this costs
 *   nothing extra. The panel's top row is read off the composited frame (the
 *   first viewport row the overlay changed), so an image that only reaches
 *   the margin above the panel - where the panel causes no redraw - is left
 *   alone, as are images wholly above the viewport and iTerm2 anchors (their
 *   reserved rows are not widened, and cell-based images are overwritten by
 *   the panel text anyway).
 *
 * The `tui` handed to ctx.ui.custom factories is not necessarily the renderer
 * itself. Since pi 0.84 it is a stable Proxy (createInteractiveTuiReference)
 * whose property reads return fresh forwarding closures that re-resolve the
 * CURRENT method at call time - so capturing a method and calling it from a
 * wrapper assigned back onto `tui` recurses into the wrapper itself, and the
 * proxy has no deleteProperty/getOwnPropertyDescriptor traps, so `delete`
 * and Object.hasOwn silently miss the real renderer. Both are avoided by
 * construction here:
 * - The original is taken from the PROTOTYPE CHAIN (the proxy forwards
 *   getPrototypeOf), which yields the pristine class method - never a
 *   forwarding closure, never an installed wrapper.
 * - The wrapper is a plain method using `this`, so it acts on whichever
 *   renderer pi invokes it on.
 * - Restore assigns the prototype method back (assignment forwards through
 *   the proxy; an own property equal to the prototype method is inert), so
 *   repeated open/close cycles never stack wrappers.
 *
 * Delete this file once pi-tui blanks covered image blocks itself.
 */

import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

// pi-tui does not export its isImageLine; these are the two escape prefixes
// it recognizes (kitty APC and iTerm2 OSC 1337 inline files). The ESC byte is
// spelled out so the prefixes cannot match ordinary text.
const ESC = String.fromCharCode(0x1b);
const KITTY = `${ESC}_G`;
const ITERM2 = `${ESC}]1337;File=`;
/** Bound on the upward search for an image anchored above the viewport. */
const MAX_IMAGE_ROWS = 200;

type Composite = (lines: string[], termWidth: number, termHeight: number) => string[];

/** The class method, found by walking the (proxy-forwarded) prototype chain. */
function prototypeComposite(tui: TUI): Composite | undefined {
  for (let proto = Object.getPrototypeOf(tui); proto; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, "compositeOverlays");
    if (typeof descriptor?.value === "function") return descriptor.value as Composite;
  }
  return undefined;
}

function isImageLine(line: string): boolean {
  return line.includes(KITTY) || line.includes(ITERM2);
}

/** Rows a Kitty placement declares (`r=`), when it declares them. */
function kittyRows(line: string): number | undefined {
  const controls = line.slice(line.indexOf(KITTY) + KITTY.length).split(";", 1)[0] ?? "";
  const value = /(?:^|,)r=(\d+)(?:,|$)/.exec(controls)?.[1];
  const rows = value === undefined ? NaN : Number.parseInt(value, 10);
  return rows > 0 ? rows : undefined;
}

/** Copy of `lines` with every image line in the visible viewport blanked. */
export function blankViewportImageLines(lines: readonly string[], termHeight: number): string[] {
  const result = [...lines];
  for (let index = Math.max(0, result.length - termHeight); index < result.length; index += 1) {
    if (isImageLine(result[index]!)) result[index] = "";
  }
  return result;
}

/**
 * After compositing: blank a Kitty anchor above the viewport whose reserved
 * rows reach the overlay's top row. `input` is the frame handed to the
 * compositor, `composited` what it returned (padded to at least termHeight).
 * Lines above the viewport are never touched by compositing, so replacing one
 * here is equivalent to having blanked it beforehand.
 */
export function blankImageAnchorsAbovePanel(input: readonly string[], composited: string[], termHeight: number): string[] {
  const viewportStart = Math.max(0, composited.length - termHeight);
  if (viewportStart === 0) return composited;
  let panelTop = -1;
  for (let index = viewportStart; index < composited.length; index += 1) {
    if (composited[index] !== (input[index] ?? "")) {
      panelTop = index;
      break;
    }
  }
  if (panelTop === -1) return composited;
  // Walk up through the blank rows a Kitty image reserves below its anchor. Any
  // visible text ends the block, exactly as pi-tui measures reserved rows.
  const stop = Math.max(0, viewportStart - MAX_IMAGE_ROWS);
  for (let index = viewportStart - 1; index >= stop; index -= 1) {
    const line = composited[index]!;
    if (line.includes(KITTY)) {
      // The block ends at its declared rows or at the first visible text in
      // the uncomposited frame, whichever comes first.
      const declared = kittyRows(line);
      let blockEnd = index + (declared ?? MAX_IMAGE_ROWS) - 1;
      for (let row = index + 1; row <= blockEnd && row < input.length; row += 1) {
        const below = input[row] ?? "";
        if (isImageLine(below) || visibleWidth(below) > 0) {
          blockEnd = row - 1;
          break;
        }
      }
      if (blockEnd >= panelTop) {
        const result = [...composited];
        result[index] = "";
        return result;
      }
      return composited;
    }
    if (line.includes(ITERM2) || visibleWidth(line) > 0) return composited;
  }
  return composited;
}

interface PatchEntry {
  depth: number;
  original: Composite;
}

const patched = new WeakMap<TUI, PatchEntry>();

/**
 * Suppress covering image lines until the returned disposer runs. Refcounted,
 * so nested or overlapping overlays share one patch.
 */
export function suppressInlineImages(tui: TUI): () => void {
  let entry = patched.get(tui);
  if (!entry) {
    const original = prototypeComposite(tui);
    // Best-effort mitigation of a cosmetic bug: a host without an ordinary
    // prototype compositeOverlays (test fakes, future pi-tui shapes) just
    // keeps its images.
    if (!original) return () => {};
    entry = { depth: 0, original };
    patched.set(tui, entry);
    (tui as unknown as { compositeOverlays: Composite }).compositeOverlays = function (
      this: TUI, lines: string[], termWidth: number, termHeight: number,
    ): string[] {
      // Self-heal: pi's own teardown paths (e.g. /reload) hide overlays
      // without running component dispose, which would leave this wrapper
      // active forever. With no overlay mounted there is nothing to protect,
      // so pass through untouched.
      let active = false;
      let input = lines;
      try {
        active = typeof this.hasOverlay !== "function" || this.hasOverlay();
        if (active) input = blankViewportImageLines(lines, termHeight);
      } catch {
        // This runs inside pi's render loop, where a throw kills the process.
        // No cosmetic touch-up is worth that; composite the frame unchanged.
        active = false;
        input = lines;
      }
      const composited = original.call(this, input, termWidth, termHeight);
      if (!active) return composited;
      try {
        return blankImageAnchorsAbovePanel(input, composited, termHeight);
      } catch {
        return composited;
      }
    };
  }
  entry.depth += 1;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = patched.get(tui);
    if (!current) return;
    current.depth -= 1;
    if (current.depth > 0) return;
    // Assignment, not delete: pi's TUI reference proxy forwards set but has
    // no deleteProperty trap. An own property holding the prototype method is
    // behaviorally identical to no own property at all.
    (tui as unknown as { compositeOverlays: Composite }).compositeOverlays = current.original;
    patched.delete(tui);
    // The restored method stops blanking; request the pass that re-places the image.
    tui.requestRender();
  };
}
