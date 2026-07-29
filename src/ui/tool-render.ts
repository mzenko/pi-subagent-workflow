/**
 * Live tool-call row rendering for the `subagent` tool.
 *
 * The tool streams a SubagentDetails snapshot through onUpdate; pi calls
 * renderResult with that snapshot (isPartial while running, final when settled).
 *
 * Rows are a pure function of that snapshot and never read the wall clock. Pi
 * draws inline, and pi-tui escalates to a full redraw - which erases the
 * terminal's scrollback and snaps the view to the bottom - whenever the first
 * changed line sits above the visible viewport. A tool row is exactly that: it
 * keeps its place in the buffer while the conversation grows past it. Anything
 * clock-derived here (a spinner frame, a ticking elapsed) therefore repaints the
 * whole screen on every render any component asks for, for the rest of the
 * session, and the user can never scroll back.
 *
 * So the running glyph is static, and elapsed is reported only once a child has
 * settled and recorded its own end. Live elapsed lives in the /agents navigator,
 * a full-screen overlay, whose own repaints always land inside the viewport.
 *
 * Overlays are exempt for their own repaints only. Shrinking the base line
 * buffer while one is mounted shifts every overlay line up and forces the same
 * full redraw - see `paint` in ./status-widget.ts.
 */

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { SubagentEvent, SubagentHandle, SubagentSpec, SubagentStatus } from "../types.js";
import { guardedLines, linesComponent } from "./component.js";
import {
  childLabel,
  clamp,
  countStatuses,
  firstLine,
  formatDuration,
  formatTokens,
  modelEffort,
  padStart,
  shortModel,
  statusGlyph,
  type ThemeLike,
} from "./format.js";
import { sanitizeTerminalText, sanitizeTerminalTextChunks, UNTRUSTED_FIELD_MAX } from "./sanitize.js";
import { isRecord } from "../util.js";

/** Serializable per-child row snapshot carried in the tool result details. */
interface ChildSnapshot {
  id: string;
  label: string;
  modelId: string;
  /** Reasoning effort the child resolved to, shown beside the model. */
  thinking?: string;
  status: SubagentStatus;
  tokens: number;
  startedAt: number;
  endedAt?: number;
  activity?: string;
  resultLine?: string;
  error?: string;
}

const STATUSES = new Set<unknown>(["pending", "running", "completed", "failed", "aborted"]);

/** Finite number, or undefined - so a bad value reads as absent rather than NaN. */
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** String, or a fallback - the string fields below are measured and sliced. */
function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Coerce a details payload into rows that are safe to draw, or undefined.
 *
 * `details` is untrusted at render time. Pi hands back whatever the tool result
 * carried, and a call this tool *rejected* arrives as a truthy `{}` with no
 * `children` at all - reading `.children.length` on that threw inside pi's render
 * loop and killed the TUI, permanently, because the bad result is persisted and
 * replayed on every resume. Details also survive upgrades, so a resumed session
 * can replay a snapshot written by a different version of this file.
 *
 * Only the fields the renderer would break on are rewritten: `label` and `modelId`
 * get measured and sliced, the numbers are normalized so a bad snapshot cannot
 * print "NaN", and `id` keys the per-column cell maps. `thinking`, `activity`,
 * `resultLine`, and `error` are only ever interpolated, so they pass through.
 */
export function safeDetails(details: unknown): SubagentDetails | undefined {
  if (!isRecord(details) || !Array.isArray(details.children)) return undefined;
  const children = details.children.filter(isRecord).map((child, index): ChildSnapshot => ({
    ...child,
    id: text(child.id, `child-${index}`),
    label: text(child.label, ""),
    modelId: text(child.modelId, ""),
    status: STATUSES.has(child.status) ? child.status as SubagentStatus : "pending",
    tokens: number(child.tokens) ?? 0,
    startedAt: number(child.startedAt) ?? 0,
    endedAt: number(child.endedAt),
  }));
  return children.length === 0 ? undefined : { fanout: details.fanout === true, children };
}

/** Details attached to the subagent tool result for TUI rendering. */
export interface SubagentDetails {
  fanout: boolean;
  children: ChildSnapshot[];
}

const LABEL_MIN = 6;
const LABEL_MAX = 28;
const MODEL_MAX = 24;
/** Wide enough for the longest formatTokens output ("123.4k tok"), so the
 * trailing field still starts at the same column once a child passes 10k. */
const TOKENS_WIDTH = 10;
const GAP = "  ";
/**
 * Rows shown before a collapsed (not expanded) fan-out folds into a count.
 *
 * This is a smaller number, not a height bound: an expanded block is 1 + N lines
 * for N children. A streaming block taller than the terminal has its top rows
 * above the viewport, so each new snapshot forces the scrollback-erasing full
 * redraw described above. Measured: 16 children expanded starts erasing at 24
 * rows or fewer, while the collapsed default is clean from 20 rows up.
 *
 * Left as is deliberately. It needs both `wait: true` (the tool description
 * steers hard against it) and the user opting into expansion, it predates the
 * clock fix rather than following from it, and capping the rows would blank out
 * exactly the detail expanding asked for. pi's own bash tool streams expanded
 * output uncapped and adds a 1Hz invalidate on top.
 */
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
        thinking: handle.resolved?.thinkingLevel,
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

/** Wall-clock duration, known only once a child has recorded its own end. */
function elapsedCell(child: ChildSnapshot): string {
  return child.endedAt === undefined ? "" : formatDuration(child.endedAt - child.startedAt);
}

/**
 * Render the per-child rows (and a fan-out header) as width-clamped lines.
 * Columns align across children; the trailing field flexes and is clipped to the
 * terminal width by truncateToWidth (ANSI-aware).
 */
export function renderRows(details: SubagentDetails, theme: ThemeLike, width: number, expanded = true): string[] {
  // Never exceed the host-supplied width: pi-tui aborts the process on any
  // over-wide line, so there is no minimum layout width worth crashing for. A
  // cramped row is a cosmetic problem; a wide one ends the session.
  const cap = Math.max(1, width);
  const all = details.children;
  const collapsed = !expanded && all.length > COLLAPSED_ROWS;
  const children = collapsed ? all.slice(0, COLLAPSED_ROWS) : all;
  const labelWidth = clamp(Math.max(...children.map((child) => child.label.length), LABEL_MIN), LABEL_MIN, LABEL_MAX);
  // Model and effort share one cell, so alignment is computed on the combined
  // text rather than the model id alone.
  const modelCells = new Map(children.map((child) => [child.id, modelEffort(child.modelId, child.thinking, MODEL_MAX)]));
  const modelWidth = clamp(Math.max(0, ...[...modelCells.values()].map((cell) => cell.length)), 0, MODEL_MAX);
  // Duration exists only for settled children, so the column collapses away
  // entirely while a fan-out is still running instead of reserving blank space.
  const elapsedCells = new Map(children.map((child) => [child.id, elapsedCell(child)]));
  const elapsedWidth = Math.max(0, ...[...elapsedCells.values()].map((cell) => cell.length));

  const lines: string[] = [];
  if (details.fanout) lines.push(truncateToWidth(renderHeader(details, theme), cap));

  for (const child of children) {
    const glyph = statusGlyph(child.status, theme, 0, false);
    const label = truncateToWidth(child.label, labelWidth, "…", true);
    const tokens = theme.fg("dim", padStart(`${formatTokens(child.tokens)} tok`, TOKENS_WIDTH));
    const cells = [`${glyph} ${label}`];
    if (modelWidth > 0) cells.push(theme.fg("dim", truncateToWidth(sanitizeTerminalText(modelCells.get(child.id) ?? ""), modelWidth, "…", true)));
    if (elapsedWidth > 0) cells.push(theme.fg("dim", padStart(elapsedCells.get(child.id) ?? "", elapsedWidth)));
    cells.push(tokens);
    const rest = trailing(child, theme);
    const head = cells.join(GAP);
    const line = rest ? `${head}${GAP}${rest}` : head;
    lines.push(truncateToWidth(line, cap));
  }
  if (collapsed) lines.push(truncateToWidth(theme.fg("dim", `  +${all.length - COLLAPSED_ROWS} more (expand to view)`), cap));
  return lines;
}

function renderHeader(details: SubagentDetails, theme: ThemeLike): string {
  const counts = countStatuses(details.children.map((child) => child.status));
  const marker = counts.active
    ? statusGlyph("running", theme, 0, false)
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
  return linesComponent((width) => [truncateToWidth(callHeaderLine(info, theme), Math.max(1, width))], "subagent call header");
}

/** Component rendering rows straight from the latest snapshot. */
class SubagentRowsComponent implements Component {
  private details: SubagentDetails | undefined;
  private fallback: string[] = [];
  private expanded = true;
  private readonly draw = guardedLines("subagent rows", (width) => this.details
    ? renderRows(this.details, this.theme, width, this.expanded)
    : this.fallback.map((line) => truncateToWidth(line, Math.max(1, width))));
  constructor(private readonly theme: ThemeLike) {}
  /** Stores the normalized snapshot; `details` is untrusted here. */
  set(details: unknown, fallback: string[], expanded: boolean): void {
    this.details = safeDetails(details);
    this.fallback = fallback;
    this.expanded = expanded;
  }
  render(width: number): string[] {
    return this.draw(width);
  }
  invalidate(): void {}
}

/**
 * renderResult hook body. No invalidate timer: the rows change only when a new
 * snapshot arrives, and pi already renders on that.
 *
 * Defining renderResult replaces pi's own result rendering outright, so when
 * there are no drawable rows - a call this tool rejected carries `details: {}` -
 * the result text has to be shown here or the user never learns why it failed.
 */
export function renderSubagentResult(
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean },
  theme: ThemeLike,
  lastComponent: Component | undefined,
): Component {
  const textParts = (result.content ?? [])
    .flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []);
  const fallback = textParts.length === 0
    ? []
    : sanitizeTerminalTextChunks(textParts, UNTRUSTED_FIELD_MAX, true).split("\n");
  const component = lastComponent instanceof SubagentRowsComponent ? lastComponent : new SubagentRowsComponent(theme);
  component.set(result.details, fallback, options.expanded);
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
      thinking: handle.resolved?.thinkingLevel,
      status: handle.status,
      tokens: 0,
      startedAt: handle.startedAt,
    })),
  };
}
