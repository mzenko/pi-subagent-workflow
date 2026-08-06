/**
 * Blank inline-image lines in the visible viewport while an overlay is mounted.
 *
 * pi-tui composites overlays over text lines but deliberately skips image
 * lines (compositeLineAt returns the base line untouched when it carries an
 * image escape), and kitty graphics placements default to z=0, which draws
 * above text - so an inline image under the /agents panel always paints over
 * it, and pi-tui re-transmits the placement on every panel repaint. Upstream
 * declined to blank covered image blocks in compositeOverlays (pi issue
 * #6995), so this patches the mounted TUI's Container.render while an overlay
 * of ours is up: image lines become empty lines, pi-tui's own differential
 * pass then deletes the kitty placement, and the overlay composites normally.
 * On unmount the patch is removed and the same differential pass re-transmits
 * the image.
 *
 * Two deliberate scope limits:
 * - Viewport only: blanking an image line above the viewport moves
 *   firstChanged above prevViewportTop, which sends pi-tui down its
 *   fullRender(true) path - a screen clear that erases the terminal's
 *   scrollback. A multi-row image straddling the viewport top therefore keeps
 *   its placement; the panel's one-row margin keeps that off the panel itself.
 * - ALL viewport images are blanked, not only rows the panel covers:
 *   extensions cannot see overlay geometry, and the panel covers ~90% of the
 *   screen anyway.
 *
 * Delete this file once pi-tui blanks covered image blocks itself.
 */

import type { TUI } from "@earendil-works/pi-tui";

// pi-tui does not export its isImageLine; these are the two escape prefixes
// it recognizes (kitty APC and iTerm2 OSC 1337 inline files).
const KITTY = "\u001b_G";
const ITERM2 = "\u001b]1337;File=";

interface PatchEntry {
  depth: number;
  original: (width: number) => string[];
  /** Whether `render` was an own property before patching (it normally is not). */
  hadOwnRender: boolean;
}

const patched = new WeakMap<TUI, PatchEntry>();

/**
 * Suppress viewport image lines until the returned disposer runs. Refcounted,
 * so nested or overlapping overlays share one patch.
 */
export function suppressInlineImages(tui: TUI): () => void {
  // Best-effort mitigation of a cosmetic bug: a host without a patchable
  // render (test fakes; a future pi-tui that reshapes the class) just keeps
  // its images.
  if (typeof tui.render !== "function") return () => {};
  let entry = patched.get(tui);
  if (!entry) {
    // Keep the raw method and call-bind it per invocation. Capturing a
    // .bind() and assigning it back on restore would leave a bound wrapper as
    // an own property, and the next mount would wrap that wrapper - one extra
    // frame of call depth per open/close cycle, forever.
    const original = tui.render as (width: number) => string[];
    entry = { depth: 0, original, hadOwnRender: Object.hasOwn(tui, "render") };
    patched.set(tui, entry);
    (tui as { render: (width: number) => string[] }).render = (width: number) => {
      const lines = original.call(tui, width);
      // Self-heal: pi's own teardown paths (e.g. /reload) hide overlays
      // without running component dispose, which would leave this patch
      // active forever. With no overlay mounted there is nothing to protect,
      // so pass through untouched.
      if (typeof tui.hasOverlay === "function" && !tui.hasOverlay()) return lines;
      const start = Math.max(0, lines.length - (tui.terminal?.rows ?? 24));
      for (let index = start; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line.includes(KITTY) || line.includes(ITERM2)) lines[index] = "";
      }
      return lines;
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
    if (current.hadOwnRender) {
      (tui as { render: (width: number) => string[] }).render = current.original;
    } else {
      // The method came from the prototype; removing the own property
      // restores it without leaving any wrapper behind.
      delete (tui as { render?: (width: number) => string[] }).render;
    }
    patched.delete(tui);
    // The restored render changes the blanked lines back; request the pass
    // that re-transmits the image.
    tui.requestRender();
  };
}
