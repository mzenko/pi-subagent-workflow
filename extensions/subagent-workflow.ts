import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { subagentRunner } from "../src/runner/runner.js";
import { registerWorkflowSettingsCommands } from "../src/settings/commands.js";
import {
  acknowledgeDeliveryMessage,
  claimRunDelivery,
  DELIVERY_PROTOCOL_VERSION,
  deliveryMarkerMatches,
  markSessionClosed,
  markSessionOpen,
  parseRunDeliveryIdentity,
  queueAcknowledgedDelivery,
  retryDeferredPublications,
  type ClaimedDeliveryTarget,
  type RunDeliveryIdentity,
} from "../src/store/delivery-marker.js";
import { runOwnerIsLive } from "../src/store/lease.js";
import { projectRunSnapshot, snapshotSaysLive } from "../src/store/run-projection.js";
import { encodeCwd } from "../src/store/run-store.js";
import { readRunSnapshot } from "../src/store/run-snapshot.js";
import { applyLiveWorkflowSettings, globalWorkflowSettings } from "../src/settings/runtime.js";
import { registerSubagentTool } from "../src/tool/subagent-tool.js";
import { registerEntryMarkers } from "../src/ui/entry-markers.js";
import { registerNavigator } from "../src/ui/navigator/navigator.js";
import { SubagentStatusWidget } from "../src/ui/status-widget.js";
import { safeDeliveryValue } from "../src/ui/delivery-safe.js";
import { SubagentUsageFooter } from "../src/ui/usage-footer.js";
import { markTuiSession, reportDiagnostic } from "../src/diagnostics.js";
import { childLabel, errorMessage, isRecord } from "../src/util.js";
import { approveLaunch } from "../src/workflow/approval.js";
import type { StartedWorkflow } from "../src/workflow/launch.js";
import { registerSavedWorkflowCommands } from "../src/workflow/commands.js";
import { ConsentStore } from "../src/workflow/consent.js";
import { parseWorkflowScript } from "../src/workflow/parser.js";
import { readSavedScript, resolveSavedWorkflow } from "../src/workflow/saved.js";
import { registerWorkflowTool } from "../src/workflow/workflow-tool.js";

const selfPath = fileURLToPath(import.meta.url);
const CATCH_UP_RUN_CAP = 10;

type TerminalStatus = "completed" | "failed" | "aborted";

export interface CatchUpRun {
  runId: string;
  runDir: string;
  label: string;
  status: TerminalStatus;
  createdAt: number;
  generation: number;
}

/** Claim terminal runs using the same ownership lock as workflow resume. */
function claimCatchUpRuns(
  cwd: string,
  sessionId: string,
  runsRoot: string = join(getAgentDir(), "subagent-workflow", "runs"),
  ownerIsLive: (runDir: string) => boolean = runOwnerIsLive,
): CatchUpRun[] {
  const runRoot = join(runsRoot, encodeCwd(cwd));
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(runRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const candidates: CatchUpRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = join(runRoot, entry.name);
    try {
      const snapshot = readRunSnapshot(runDir);
      if (snapshot.generationPending) continue;
      const record = jsonObject(snapshot.record);
      const identity = parseRunDeliveryIdentity(record);
      // Records without a protocol identity predate acknowledgement tracking.
      // Redelivering them could create a duplicate model turn, so leave them visible only.
      if (!identity || deliveryMarkerMatches(runDir, identity)) continue;
      const parent = jsonObject(record?.parent);
      if (parent?.sessionId !== sessionId || ownerIsLive(runDir)) continue;
      const projection = projectRunSnapshot(snapshot, entry.name, { ownerWasDead: snapshotSaysLive(snapshot) });
      const status = projection.summary.corrupt ? undefined : terminalStatus(projection.summary.status);
      if (!status) continue;
      const createdAt = typeof record?.createdAt === "string" ? Date.parse(record.createdAt) : NaN;
      candidates.push({
        runId: entry.name,
        runDir,
        label: persistedRunLabel(record),
        status,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        generation: identity.generation,
      });
    } catch (error) {
      reportDiagnostic(`[subagent-workflow] catch-up scan skipped ${runDir}: ${errorMessage(error)}`);
    }
  }

  candidates.sort((left, right) => right.createdAt - left.createdAt || right.runId.localeCompare(left.runId));
  const claimed: CatchUpRun[] = [];
  for (const candidate of candidates) {
    let claim: ClaimedDeliveryTarget | "conflict" | undefined;
    try {
      if (ownerIsLive(candidate.runDir)) continue;
      const identity = catchUpIdentity(candidate);
      claim = claimRunDelivery(candidate.runDir, identity);
      if (claim === "conflict" || !claim) continue;
      const snapshot = readRunSnapshot(candidate.runDir);
      const record = jsonObject(snapshot.record);
      const parent = jsonObject(record?.parent);
      const currentIdentity = parseRunDeliveryIdentity(record);
      const projection = projectRunSnapshot(snapshot, candidate.runId, { ownerWasDead: snapshotSaysLive(snapshot) });
      const status = projection.summary.corrupt ? undefined : terminalStatus(projection.summary.status);
      if (snapshot.generationPending
        || parent?.sessionId !== sessionId
        || !currentIdentity
        || currentIdentity.generation !== identity.generation
        || deliveryMarkerMatches(candidate.runDir, identity)
        || !status) continue;
      claimed.push({ ...candidate, status });
    } catch (error) {
      reportDiagnostic(`[subagent-workflow] catch-up claim failed for ${candidate.runDir}: ${errorMessage(error)}`);
    } finally {
      if (claim !== "conflict") claim?.ownership.release();
    }
  }
  return claimed;
}

export function formatCatchUpMessage(runs: readonly CatchUpRun[]): string {
  const shown = runs.slice(0, CATCH_UP_RUN_CAP);
  const lines = shown.map((run) => [run.runId, run.label, run.status, run.runDir].map(safeDeliveryValue).join(" | "));
  if (runs.length > shown.length) lines.push(`and ${runs.length - shown.length} more; see /agents`);
  return `Recovered background run deliveries:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

export function catchUpUndeliveredRuns(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runsRoot?: string,
): CatchUpRun[] {
  // Settle acknowledged-but-conflicted publications first so a delivery that
  // was consumed in a previous session cannot be re-queued as undelivered.
  retryDeferredPublications();
  const sessionId = ctx.sessionManager.getSessionId();
  const runs = claimCatchUpRuns(ctx.cwd, sessionId, runsRoot);
  if (runs.length === 0) return runs;
  const message = formatCatchUpMessage(runs);
  queueAcknowledgedDelivery(pi, {
    sessionId,
    message,
    catchUp: true,
    targets: runs.map((run) => ({ runDir: run.runDir, identity: catchUpIdentity(run) })),
  });
  return runs;
}

function catchUpIdentity(run: CatchUpRun): RunDeliveryIdentity {
  return { protocol: DELIVERY_PROTOCOL_VERSION, generation: run.generation };
}

function terminalStatus(value: unknown): TerminalStatus | undefined {
  return value === "completed" || value === "failed" || value === "aborted" ? value : undefined;
}

function persistedRunLabel(record: Record<string, unknown> | undefined): string {
  const children = Array.isArray(record?.children) ? record.children : [];
  if (record?.kind === "workflow") return "workflow";
  if (children.length > 1) return `fan-out ×${children.length}`;
  const child = jsonObject(children[0]);
  const resolvedLabel = jsonObject(child?.resolved)?.label;
  if (typeof resolvedLabel === "string" && resolvedLabel.trim()) return resolvedLabel.trim();
  const spec = jsonObject(child?.spec);
  if (typeof spec?.prompt === "string") {
    return childLabel({ prompt: spec.prompt, ...(typeof spec.label === "string" ? { label: spec.label } : {}) });
  }
  return "subagent";
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function userMessageText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

export default function subagentWorkflow(pi: ExtensionAPI): void {
  const widget = new SubagentStatusWidget(subagentRunner);
  const usageFooter = new SubagentUsageFooter(subagentRunner);
  const consent = new ConsentStore();
  const settings = globalWorkflowSettings();
  const applySettings = () => applyLiveWorkflowSettings(settings.get(), subagentRunner, widget);
  applySettings();
  const unsubscribeSettings = settings.subscribe(applySettings);
  const resolveSaved = (name: string, cwd: string): string | undefined => {
    const workflow = resolveSavedWorkflow(name, cwd);
    return workflow ? readSavedScript(workflow) : undefined;
  };
  registerEntryMarkers(pi);
  registerSubagentTool(pi, selfPath, widget);
  const policy = () => settings.get().workflowApproval;
  const observeRun = (run: StartedWorkflow, ctx: ExtensionContext) => {
    usageFooter.trackRun(run.runDir, ctx);
    widget.observeWorkflowStarted(run, ctx);
  };
  registerWorkflowTool(pi, selfPath, { consent, approve: approveLaunch, approvalPolicy: policy, observeRun, resolveSaved });
  pi.registerCommand("background", {
    description: "Move all waited subagent/workflow runs in this session to the background",
    handler: async (_args, ctx) => {
      const detached = subagentRunner.detachWaitedRuns(ctx.sessionManager.getSessionId());
      const message = detached.length === 0
        ? "No waited runs to background"
        : `Backgrounded ${detached.join(", ")}; results will arrive as steered messages`;
      if (ctx.hasUI) ctx.ui.notify(message, "info");
      else console.log(message);
    },
  });

  // Register the navigator before the other /work* commands. Pi's fuzzy
  // autocomplete preserves registration order for equal prefix matches, so
  // typing /work now selects /workflows first without renaming public commands.
  let saveWorkflow: ReturnType<typeof registerSavedWorkflowCommands> | undefined;
  const openNavigator = registerNavigator(pi, {
    runner: subagentRunner,
    describeWorkflow: (script) => parseWorkflowScript(script).meta.name,
    saveWorkflowScript: async (runId, ctx) => saveWorkflow?.(runId, ctx),
  });
  pi.registerShortcut("shift+down", {
    description: "Open the agent navigator (/agents)",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await openNavigator(ctx);
    },
  });
  saveWorkflow = registerSavedWorkflowCommands(pi, {
    consent,
    approve: approveLaunch,
    approvalPolicy: policy,
    observeRun,
    selfPath,
  });
  registerWorkflowSettingsCommands(pi, { settings, clearApprovals: () => consent.clear() });
  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") return;
    acknowledgeDeliveryMessage(ctx.sessionManager.getSessionId(), userMessageText(event.message.content));
  });
  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    markSessionOpen(sessionId);
    if (ctx.hasUI) markTuiSession();
    usageFooter.attach(ctx);
    try {
      catchUpUndeliveredRuns(pi, ctx);
    } catch (error) {
      reportDiagnostic(`[subagent-workflow] startup catch-up failed: ${errorMessage(error)}`);
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    markSessionClosed(sessionId);
    try {
      unsubscribeSettings();
    } catch (error) {
      reportDiagnostic(`[subagent-workflow] settings disposal failed: ${errorMessage(error)}`);
    }
    try {
      widget.dispose();
    } catch (error) {
      reportDiagnostic(`[subagent-workflow] status widget disposal failed: ${errorMessage(error)}`);
    }
    try {
      usageFooter.dispose();
    } catch (error) {
      reportDiagnostic(`[subagent-workflow] usage footer disposal failed: ${errorMessage(error)}`);
    }
    try {
      await subagentRunner.disposeForSession(sessionId);
    } catch (error) {
      reportDiagnostic(`[subagent-workflow] child disposal failed: ${errorMessage(error)}`);
    }
  });
}
