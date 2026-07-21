import type { Component } from "@earendil-works/pi-tui";

/** A static pi-tui Component that recomputes its lines from the viewport width. */
export function linesComponent(build: (width: number) => string[]): Component {
  return {
    render: (width: number) => build(Math.max(1, width)),
    invalidate: () => {},
  };
}
