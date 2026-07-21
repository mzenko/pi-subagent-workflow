/**
 * Live tool-call row rendering for the `subagent` tool.
 *
 * The tool streams a SubagentDetails snapshot through onUpdate; pi calls
 * renderResult with that snapshot (isPartial while running, final when settled).
 * Rows recompute elapsed time and the spinner frame from the wall clock on every
 * render, so a lightweight invalidate timer animates them without new snapshots.
 */

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { SubagentEvent, SubagentHandle, SubagentSpec, SubagentStatus } from "../types.js";
import { linesComponent } from "./component.js";
import {
  childLabel,
  clamp,
  countStatuses,
  firstLine,
  formatDuration,
  formatTokens,
  padStart,
  shortModel,
  statusGlyph,
  type ThemeLike,
} from "./format.js";
import { sanitizeTerminalText } from "./sanitize.js";

/** Serializable per-child row snapshot carried in the tool result details. */
interface ChildSnapshot {
  id: string;
  label: string;
  modelId: string;
  status: SubagentStatus;
  tokens: number;
  startedAt: number;
  endedAt?: number;
  activity?: string;
  resultLine?: string;
  error?: string;
}

/** Details attached to the subagent tool result for TUI rendering. */
export interface SubagentDetails {
  fanout: boolean;
  children: ChildSnapshot[];
}

const LABEL_MIN = 6;
const LABEL_MAX = 28;
const MODEL_MAX = 18;
const ELAPSED_WIDTH = 6;
const TOKENS_WIDTH = 8;
const GAP = "  ";
/** Rows shown before a collapsed (not expanded) fan-out folds into a count. */
const COLLAPSED_ROWS = 8;

function truncateActivity(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}

/**
 * Accumulates the streaming-only fields (activity, tokens, result text) that are
 * not readable from a handle. Status, model, and timing are read live from the
 * handles at snapshot time, so this stays a thin overlay.
 */
export class SubagentRowTracker {
  private readonly activity = new Map<string, string>();
  private readonly tokens = new Map<string, number>();
  private readonly endedAt = new Map<string, number>();
  private readonly resultLine = new Map<string, string>();
  private readonly error = new Map<string, string>();

  constructor(private readonly fanout: boolean, private readonly now: () => number = Date.now) {}

  observe(event: SubagentEvent): void {
    // Activity, result text, and error are child-authored; strip control and
    // escape sequences before they reach the terminal.
    // Sanitize BEFORE truncating: truncating first can cut an escape sequence
    // mid-way, leaving a fragment the sanitizer then discards along with the
    // valid text after it.
    if (event.type === "activity") this.activity.set(event.id, truncateActivity(sanitizeTerminalText(event.description)));
    else if (event.type === "usage") this.tokens.set(event.id, event.usage.input + event.usage.output);
    else if (event.type === "result") {
      this.endedAt.set(event.id, this.now());
      this.tokens.set(event.id, event.result.usage.input + event.result.usage.output);
      const line = firstLine(event.result.text);
      if (line) this.resultLine.set(event.id, sanitizeTerminalText(line));
      if (event.result.error) this.error.set(event.id, sanitizeTerminalText(event.result.error));
    }
  }

  snapshot(handles: readonly SubagentHandle[]): SubagentDetails {
    return {
      fanout: this.fanout,
      children: handles.map((handle) => ({
        id: handle.id,
        label: sanitizeTerminalText(childLabel(handle.spec)),
        modelId: sanitizeTerminalText(shortModel(handle.resolved?.modelId)),
        status: handle.status,
        tokens: this.tokens.get(handle.id) ?? 0,
        startedAt: handle.startedAt,
        endedAt: this.endedAt.get(handle.id),
        activity: this.activity.get(handle.id),
        resultLine: this.resultLine.get(handle.id),
        error: this.error.get(handle.id),
      })),
    };
  }
}

/** The trailing free-text field for a row: result/error when done, else activity. */
function trailing(child: ChildSnapshot, theme: ThemeLike): string {
  if (child.error) return theme.fg("error", child.error);
  if (child.resultLine) return theme.fg("dim", child.resultLine);
  if (child.activity) return theme.fg("dim", child.activity);
  return "";
}

/**
 * Render the per-child rows (and a fan-out header) as width-clamped lines.
 * Columns align across children; the trailing field flexes and is clipped to the
 * terminal width by truncateToWidth (ANSI-aware).
 */
export function renderRows(details: SubagentDetails, theme: ThemeLike, width: number, now: number, animate: boolean, expanded = true): string[] {
  const cap = Math.max(20, width);
  const all = details.children;
  const collapsed = !expanded && all.length > COLLAPSED_ROWS;
  const children = collapsed ? all.slice(0, COLLAPSED_ROWS) : all;
  const labelWidth = clamp(Math.max(...children.map((child) => child.label.length), LABEL_MIN), LABEL_MIN, LABEL_MAX);
  const hasModel = children.some((child) => child.modelId.length > 0);
  const modelWidth = hasModel ? clamp(Math.max(...children.map((child) => child.modelId.length)), 1, MODEL_MAX) : 0;

  const lines: string[] = [];
  if (details.fanout) lines.push(truncateToWidth(renderHeader(details, theme, now, animate), cap));

  for (const child of children) {
    const glyph = statusGlyph(child.status, theme, now, animate);
    const label = truncateToWidth(child.label, labelWidth, "…", true);
    const elapsedMs = (child.endedAt ?? now) - child.startedAt;
    const elapsed = theme.fg("dim", padStart(formatDuration(elapsedMs), ELAPSED_WIDTH));
    const tokens = theme.fg("dim", padStart(`${formatTokens(child.tokens)} tok`, TOKENS_WIDTH));
    const cells = [`${glyph} ${label}`];
    if (modelWidth > 0) cells.push(theme.fg("dim", truncateToWidth(sanitizeTerminalText(child.modelId), modelWidth, "…", true)));
    cells.push(elapsed, tokens);
    const rest = trailing(child, theme);
    const head = cells.join(GAP);
    const line = rest ? `${head}${GAP}${rest}` : head;
    lines.push(truncateToWidth(line, cap));
  }
  if (collapsed) lines.push(truncateToWidth(theme.fg("dim", `  +${all.length - COLLAPSED_ROWS} more (expand to view)`), cap));
  return lines;
}

function renderHeader(details: SubagentDetails, theme: ThemeLike, now: number, animate: boolean): string {
  const counts = countStatuses(details.children.map((child) => child.status));
  const marker = counts.active
    ? statusGlyph("running", theme, now, animate)
    : theme.fg(counts.failed > 0 ? "error" : "success", "●");
  const parts: string[] = [`${counts.done}/${counts.total} done`];
  if (counts.running > 0) parts.push(theme.fg("accent", `${counts.running} running`));
  if (counts.pending > 0) parts.push(theme.fg("dim", `${counts.pending} queued`));
  if (counts.failed > 0) parts.push(theme.fg("error", `${counts.failed} failed`));
  return `${marker} ${theme.bold("fan-out")} ${theme.fg("dim", "·")} ${parts.join(theme.fg("dim", " · "))}`;
}

interface CallHeaderInfo {
  fanout: boolean;
  count?: number;
  label?: string;
}

/** Single-line call header line (label / fan-out size). */
export function callHeaderLine(info: CallHeaderInfo, theme: ThemeLike): string {
  const title = info.fanout
    ? `subagent fan-out · ${info.count ?? 0} children`
    : `subagent · ${sanitizeTerminalText(info.label ?? "Subagent")}`;
  return theme.fg("toolTitle", theme.bold(title));
}

/** Single-line call header component shown above the rows. */
export function renderCallHeader(info: CallHeaderInfo, theme: ThemeLike): Component {
  return linesComponent((width) => [truncateToWidth(callHeaderLine(info, theme), Math.max(20, width))]);
}

export interface SubagentRowsState {
  interval?: ReturnType<typeof setInterval>;
}

/** Component that recomputes rows (elapsed, spinner) from the clock every render. */
class SubagentRowsComponent implements Component {
  private details: SubagentDetails | undefined;
  private animate = false;
  private expanded = true;
  constructor(private readonly theme: ThemeLike) {}
  set(details: SubagentDetails | undefined, animate: boolean, expanded: boolean): void {
    this.details = details;
    this.animate = animate;
    this.expanded = expanded;
  }
  render(width: number): string[] {
    if (!this.details || this.details.children.length === 0) return [];
    return renderRows(this.details, this.theme, Math.max(1, width), Date.now(), this.animate, this.expanded);
  }
  invalidate(): void {}
}

/**
 * renderResult hook body. Sets up (and tears down) a ~10Hz invalidate timer while
 * the result is partial so the spinner and elapsed animate between snapshots.
 */
export function renderSubagentResult(
  details: SubagentDetails | undefined,
  options: { isPartial: boolean; expanded: boolean },
  theme: ThemeLike,
  state: SubagentRowsState,
  invalidate: () => void,
  lastComponent: Component | undefined,
): Component {
  if (options.isPartial && !state.interval) state.interval = setInterval(invalidate, 100);
  if (!options.isPartial && state.interval) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
  const component = lastComponent instanceof SubagentRowsComponent ? lastComponent : new SubagentRowsComponent(theme);
  component.set(details, options.isPartial, options.expanded);
  return component;
}

/** Seed details for a run whose live progress will not stream (background spawns). */
export function initialDetails(specs: SubagentSpec[], handles: readonly SubagentHandle[], fanout: boolean): SubagentDetails {
  return {
    fanout,
    children: handles.map((handle, index) => ({
      id: handle.id,
      label: sanitizeTerminalText(childLabel(specs[index] ?? handle.spec)),
      modelId: sanitizeTerminalText(shortModel(handle.resolved?.modelId)),
      status: handle.status,
      tokens: 0,
      startedAt: handle.startedAt,
    })),
  };
}
