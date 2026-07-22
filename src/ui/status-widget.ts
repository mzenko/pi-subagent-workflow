/**
 * Below-editor status widget: a glanceable list of running subagent work.
 *
 * Visible only while at least one child is running or queued; cleared when idle.
 * Follows pi's proven widget pattern (tintinweb/pi-subagents, QuintinShaw
 * workflows): register the factory once and drive re-renders with
 * tui.requestRender() on a ~10Hz timer, rather than re-registering per update.
 */

import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpawnedRun, SubagentRunner } from "../runner/runner.js";
import type { StartedWorkflow } from "../workflow/launch.js";
import type { SubagentEvent, SubagentHandle, WorkflowPhase } from "../types.js";
import { reportDiagnostic } from "../diagnostics.js";
import { errorMessage } from "../util.js";
import {
  childLabel,
  countStatuses,
  formatDuration,
  formatTokens,
  spinnerFrame,
  statusGlyph,
  type StatusCounts,
  type ThemeLike,
} from "./format.js";
import { sanitizeTerminalText } from "./sanitize.js";

const WIDGET_KEY = "subagent-workflow";
const STATUS_KEY = "subagent-workflow";
const FALLBACK_ROW_CAP = 6;
const LABEL_WIDTH = 26;
const REFRESH_MS = 100;

type WidgetCtx = Pick<ExtensionContext, "ui" | "hasUI">;

interface TrackedRun {
  kind: "subagent" | "workflow";
  fanout: boolean;
  /** Workflow meta name, or the first spec's label for direct spawns. */
  label: string;
  /** Declared phase skeleton (workflow runs only). */
  phases: WorkflowPhase[];
  /** Phase of the most recently admitted child (workflow runs only). */
  currentPhase?: string;
  handles: SubagentHandle[];
  seenHandles: Set<string>;
  startedAt: number;
  tokens: Map<string, number>;
  unsubscribers: Array<() => void>;
}

/** Per-run view used by the pure line renderer. */
export interface WidgetRunView {
  kind?: "subagent" | "workflow";
  label: string;
  /** Formatted current-phase segment for workflow rows, e.g. "Research (2/3)". */
  phase?: string;
  counts: StatusCounts;
  startedAt: number;
  tokens: number;
}

function runLabel(run: Pick<TrackedRun, "kind" | "fanout" | "label" | "handles">): string {
  if (run.kind === "workflow") return sanitizeTerminalText(run.label);
  if (run.fanout) return `fan-out ×${run.handles.length}`;
  return sanitizeTerminalText(childLabel(run.handles[0]!.spec));
}

function phaseView(run: Pick<TrackedRun, "kind" | "phases" | "currentPhase">): string | undefined {
  if (run.kind !== "workflow" || !run.currentPhase) return undefined;
  const index = run.phases.findIndex((phase) => phase.title === run.currentPhase);
  const position = index >= 0 && run.phases.length > 1 ? ` (${index + 1}/${run.phases.length})` : "";
  return `${sanitizeTerminalText(run.currentPhase)}${position}`;
}

function runTokens(run: TrackedRun): number {
  let total = 0;
  for (const value of run.tokens.values()) total += value;
  return total;
}

/** Keep the widget near one quarter of the terminal, or retain the old cap when height is unavailable. */
export function statusWidgetRowCap(terminalRows: number | undefined): number {
  if (terminalRows === undefined || !Number.isFinite(terminalRows) || terminalRows < 1) return FALLBACK_ROW_CAP;
  return Math.max(1, Math.floor(terminalRows / 4));
}

function summaryParts(runs: WidgetRunView[]): string[] {
  const running = runs.reduce((sum, run) => sum + run.counts.running, 0);
  const queued = runs.reduce((sum, run) => sum + run.counts.pending, 0);
  const workflows = runs.filter((run) => run.kind === "workflow").length;
  const parts: string[] = [];
  if (workflows > 0) parts.push(`${workflows} workflow${workflows === 1 ? "" : "s"}`);
  if (running > 0) parts.push(`${running} running`);
  if (queued > 0) parts.push(`${queued} queued`);
  return parts;
}

/** Build the widget lines from active run views. Pure and unit tested. */
export function renderWidgetLines(runs: WidgetRunView[], theme: ThemeLike, width: number, now: number, maxRows = FALLBACK_ROW_CAP): string[] {
  if (runs.length === 0) return [];
  // Never exceed the host-supplied width: pi-tui kills the process on any
  // over-wide line, so there is no minimum layout width worth crashing for.
  const cap = Math.max(1, width);
  const header = `${theme.fg("accent", spinnerFrame(now))} ${theme.bold("agents")} ${theme.fg("dim", summaryParts(runs).join(" · "))}`;
  const lines: string[] = [truncateToWidth(header, cap)];

  for (const run of runs.slice(0, maxRows)) {
    const glyph = statusGlyph("running", theme, now, true);
    const label = truncateToWidth(run.label, LABEL_WIDTH, "…", true);
    const phase = run.phase ? `${theme.fg("dim", run.phase)}  ` : "";
    const progress = theme.fg("dim", run.counts.total > 0 ? `${run.counts.done}/${run.counts.total}` : "starting");
    const elapsed = theme.fg("dim", formatDuration(now - run.startedAt));
    const tokens = theme.fg("dim", `${formatTokens(run.tokens)} tok`);
    lines.push(truncateToWidth(`${glyph} ${label}  ${phase}${progress}  ${elapsed}  ${tokens}`, cap));
  }
  if (runs.length > maxRows) lines.push(truncateToWidth(theme.fg("dim", `  +${runs.length - maxRows} more runs`), cap));
  return lines;
}

export class SubagentStatusWidget {
  private ctx: WidgetCtx | undefined;
  private readonly runs = new Map<string, TrackedRun>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private tui: TUI | undefined;
  private registered = false;
  private lastStatus: string | undefined;
  private enabled = true;
  private unsubscribeSpawns: (() => void) | undefined;

  constructor(private readonly runner?: Pick<SubagentRunner, "subscribeSpawns" | "isRunActive">) {
    this.unsubscribeSpawns = runner?.subscribeSpawns((run) => this.observeSpawn(run));
  }

  /**
   * Show a workflow row from launch, before its first child spawns, and keep
   * it while the run controller is registered - a workflow between agent
   * batches (or replaying its journal) has no live child but is still running.
   */
  observeWorkflowStarted(started: StartedWorkflow, ctx: WidgetCtx): void {
    if (!ctx.hasUI) return;
    this.setCtx(ctx);
    const existing = this.runs.get(started.runId);
    if (existing) {
      existing.label = started.name;
      existing.phases = started.phases;
    } else {
      this.runs.set(started.runId, {
        kind: "workflow",
        fanout: false,
        label: started.name,
        phases: started.phases,
        currentPhase: started.phases[0]?.title,
        handles: [],
        seenHandles: new Set(),
        startedAt: Date.now(),
        tokens: new Map(),
        unsubscribers: [],
      });
    }
    this.safeUpdate();
  }

  /** Merge workflow child spawns into their run's row as agent() calls admit them. */
  private observeSpawn(spawned: SpawnedRun): void {
    const run = this.runs.get(spawned.runId);
    if (!run || run.kind !== "workflow") return;
    for (const handle of spawned.handles) {
      if (run.seenHandles.has(handle.id)) continue;
      run.seenHandles.add(handle.id);
      run.handles.push(handle);
      run.unsubscribers.push(handle.subscribe((event) => this.onEvent(spawned.runId, run.tokens, event)));
      if (handle.spec.phase !== undefined) run.currentPhase = handle.spec.phase;
    }
    this.safeUpdate();
  }

  /** Apply display settings immediately, including to an already-visible widget. */
  configure(enabled: boolean): void {
    this.enabled = enabled;
    this.safeUpdate();
  }

  /** Register a spawned run for live display. No-op without dialog-capable UI. */
  track(runId: string, handles: readonly SubagentHandle[], fanout: boolean, ctx: WidgetCtx): void {
    if (!ctx.hasUI) return;
    this.setCtx(ctx);
    const tokens = new Map<string, number>();
    const unsubscribers = handles.map((handle) =>
      handle.subscribe((event) => this.onEvent(runId, tokens, event)),
    );
    this.runs.set(runId, {
      kind: "subagent",
      fanout,
      label: "",
      phases: [],
      handles: [...handles],
      seenHandles: new Set(handles.map((handle) => handle.id)),
      startedAt: Math.min(...handles.map((handle) => handle.startedAt)),
      tokens,
      unsubscribers,
    });
    this.safeUpdate();
  }

  /** Drop all runs and clear the widget. Called on session shutdown. */
  dispose(): void {
    this.unsubscribeSpawns?.();
    this.unsubscribeSpawns = undefined;
    for (const run of this.runs.values()) run.unsubscribers.forEach((fn) => fn());
    this.runs.clear();
    this.stopTimer();
    if (this.ctx) {
      try { this.ctx.ui.setWidget(WIDGET_KEY, undefined); } catch (error) { this.logFailure(error); }
      try { this.ctx.ui.setStatus(STATUS_KEY, undefined); } catch (error) { this.logFailure(error); }
    }
    this.registered = false;
    this.tui = undefined;
    this.lastStatus = undefined;
  }

  private setCtx(ctx: WidgetCtx): void {
    if (ctx === this.ctx) return;
    this.ctx = ctx;
    this.registered = false;
    this.tui = undefined;
    this.lastStatus = undefined;
  }

  private onEvent(runId: string, tokens: Map<string, number>, event: SubagentEvent): void {
    if (event.type === "usage") tokens.set(event.id, event.usage.input + event.usage.output);
    if (event.type === "result") tokens.set(event.id, event.result.usage.input + event.result.usage.output);
    if (event.type === "status" || event.type === "result") this.pruneRun(runId);
    this.safeUpdate();
  }

  /**
   * An idle run leaves the widget immediately - except a workflow whose run
   * controller is still registered: it is between agent batches or replaying,
   * and its row must not flicker away.
   */
  private pruneRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || this.runIsActive(runId, run)) return;
    run.unsubscribers.forEach((fn) => fn());
    this.runs.delete(runId);
  }

  private runIsActive(runId: string, run: TrackedRun): boolean {
    const counts = countStatuses(run.handles.map((handle) => handle.status));
    if (counts.active) return true;
    return run.kind === "workflow" && (this.runner?.isRunActive(runId) ?? false);
  }

  private views(): WidgetRunView[] {
    const views: WidgetRunView[] = [];
    for (const [runId, run] of this.runs) {
      if (!this.runIsActive(runId, run)) {
        this.pruneRun(runId);
        continue;
      }
      views.push({
        kind: run.kind,
        label: runLabel(run),
        phase: phaseView(run),
        counts: countStatuses(run.handles.map((handle) => handle.status)),
        startedAt: run.startedAt,
        tokens: runTokens(run),
      });
    }
    return views.sort((a, b) => a.startedAt - b.startedAt);
  }

  private update(): void {
    if (!this.ctx) return;
    if (!this.enabled) {
      this.hide();
      return;
    }
    const views = this.views();

    if (views.length === 0) {
      this.hide();
      return;
    }

    const status = summaryParts(views).join(", ");
    if (status !== this.lastStatus) {
      this.ctx.ui.setStatus(STATUS_KEY, status);
      this.lastStatus = status;
    }

    if (!this.timer) this.timer = setInterval(() => this.safeUpdate(), REFRESH_MS);
    if (!this.registered) {
      this.ctx.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (width: number) => renderWidgetLines(
              this.views(),
              theme,
              Math.max(1, width),
              Date.now(),
              statusWidgetRowCap(tui.terminal?.rows),
            ),
            invalidate: () => {
              this.registered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "belowEditor" },
      );
      this.registered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private hide(): void {
    if (!this.ctx) return;
    if (this.registered) {
      this.ctx.ui.setWidget(WIDGET_KEY, undefined);
      this.registered = false;
      this.tui = undefined;
    }
    if (this.lastStatus !== undefined) {
      this.ctx.ui.setStatus(STATUS_KEY, undefined);
      this.lastStatus = undefined;
    }
    this.stopTimer();
  }

  private safeUpdate(): void {
    try {
      this.update();
    } catch (error) {
      for (const run of this.runs.values()) run.unsubscribers.forEach((fn) => fn());
      this.runs.clear();
      this.stopTimer();
      this.registered = false;
      this.tui = undefined;
      this.lastStatus = undefined;
      try { this.ctx?.ui.setWidget(WIDGET_KEY, undefined); } catch { /* host UI already failed */ }
      try { this.ctx?.ui.setStatus(STATUS_KEY, undefined); } catch { /* host UI already failed */ }
      this.logFailure(error);
    }
  }

  private logFailure(error: unknown): void {
    reportDiagnostic(`[subagent-workflow] status widget failed: ${errorMessage(error)}`);
  }
}
