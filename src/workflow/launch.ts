/**
 * Shared workflow launch path used by both the `workflow` tool and the
 * `/wf-<name>` saved-workflow commands: approve, start, record the transcript
 * marker, and (in background mode) deliver completion by steering the parent turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ParentContext } from "../runner/child.js";
import { subagentRunner } from "../runner/runner.js";
import { activityFoldFromSnapshot, type RunActivityFold } from "../store/activity-fold.js";
import {
  DELIVERY_PROTOCOL_VERSION,
  queueAcknowledgedDelivery,
  writeDeliveryMarker,
  type RunDeliveryIdentity,
} from "../store/delivery-marker.js";
import { readRunSnapshot } from "../store/run-snapshot.js";
import type { WorkflowPhase } from "../types.js";
import { buildDeliveryEnvelope, DELIVERY_ENVELOPE_BUDGET } from "../ui/delivery-envelope.js";
import { safeDeliveryValue, stringifyDeliveryJson } from "../ui/delivery-safe.js";
import { appendEntrySafely } from "../ui/entry-markers.js";
import { reportDiagnostic } from "../diagnostics.js";
import { errorMessage } from "../util.js";
import { unknownModelError } from "../runner/child.js";
import type { ApprovalContext, ApprovalDeps, ApproveLaunch, LaunchPlan } from "./approval.js";
import { startParsedWorkflow, WorkflowRunError, type WorkflowRunResult } from "./workflow-runner.js";

interface WorkflowLaunchInput {
  plan: LaunchPlan;
  resumeRunId?: string;
  /** Persisted childIds authorized to re-execute despite environment drift; resume-only. */
  rerunChildIds?: readonly string[];
  signal?: AbortSignal;
  onLog?: (message: string) => void;
}

interface WorkflowApproval {
  approve: ApproveLaunch;
  ctx: ApprovalContext;
  deps: ApprovalDeps;
}

export interface StartedWorkflow {
  runId: string;
  runDir: string;
  name: string;
  phases: WorkflowPhase[];
}

interface LaunchedWorkflow {
  started: StartedWorkflow;
  execution: Promise<WorkflowRunResult>;
}

/**
 * Approve (throws on deny), start the run, and append the run-started marker.
 * Delivery and live observation are the caller's choice after this resolves.
 */
export async function launchWorkflow(pi: ExtensionAPI, parent: ParentContext, input: WorkflowLaunchInput, approval: WorkflowApproval): Promise<LaunchedWorkflow> {
  const { workflow } = input.plan;
  const modelError = validateLiteralModels(workflow.literalModels, parent.ctx.modelRegistry);
  if (modelError) throw new Error(modelError);
  await approval.approve(input.plan, approval.ctx, approval.deps);
  const launch = startParsedWorkflow(
    { workflow, args: input.plan.args, resumeRunId: input.resumeRunId, rerunChildIds: input.rerunChildIds },
    parent,
    {
      onLog: input.onLog,
      signal: input.signal,
    },
  );
  const phases: WorkflowPhase[] = (workflow.meta.phases ?? []).map((phase) => ({ ...phase }));
  const started: StartedWorkflow = {
    runId: launch.runId,
    runDir: launch.runDir,
    name: workflow.meta.name,
    phases,
  };
  appendEntrySafely(
    pi,
    "subagent-workflow:run-started",
    workflowStartedMarker(started, approval.ctx.mode === "tui" && approval.deps.policy === "auto"),
  );
  return { started, execution: launch.execution };
}

export function workflowStartedMarker(started: StartedWorkflow, autoApproved: boolean): Record<string, unknown> {
  return {
    runId: started.runId,
    runDir: started.runDir,
    phases: started.phases,
    ...(autoApproved ? { approval: "auto" } : {}),
  };
}

/** Wire background delivery and wait for the host's consumed-message acknowledgement. */
export function deliverWorkflowInBackground(pi: ExtensionAPI, execution: Promise<WorkflowRunResult>, sessionId: string): void {
  void execution.then(
    (result) => {
      recordWorkflowCompleted(pi, result);
      const message = formatWorkflowDelivery(result);
      try {
        queueAcknowledgedDelivery(pi, {
          sessionId,
          message,
          targets: [{ runDir: result.runDir, identity: workflowDeliveryIdentity(result.generation) }],
        });
      } finally {
        subagentRunner.releaseRunActivity(result.runId);
      }
    },
    (error) => {
      const message = formatWorkflowFailure(error);
      if (error instanceof WorkflowRunError && error.generation !== undefined) {
        try {
          queueAcknowledgedDelivery(pi, {
            sessionId,
            message,
            targets: [{ runDir: error.runDir, identity: workflowDeliveryIdentity(error.generation) }],
          });
        } finally {
          subagentRunner.releaseRunActivity(error.runId);
        }
      } else {
        pi.sendUserMessage(message, { deliverAs: "steer" });
      }
    },
  ).catch((error) => {
    reportDiagnostic(`[subagent-workflow] workflow delivery failed: ${safeDeliveryValue(errorMessage(error))}`);
  });
}

export function formatWorkflowFailure(error: unknown): string {
  const message = safeDeliveryValue(errorMessage(error));
  if (!(error instanceof WorkflowRunError)) {
    return buildDeliveryEnvelope({
      header: ["Workflow run", "Status: failed"],
      failures: [`Error: ${message}`],
    });
  }
  const runId = safeDeliveryValue(error.runId);
  const runDir = safeDeliveryValue(error.runDir);
  const scriptPath = `${runDir}/script.js`;
  const aborted = error.status === "aborted";
  // The child errors are usually the actionable part: a script-level TypeError
  // like "cannot read properties of null" is the SYMPTOM of an agent() call
  // failing and resolving to null.
  const failures = formatGroupedFailures(error.failedChildren);
  if (!aborted && error.failedChildren.length > 0) {
    failures.push("Note: a failed agent() call resolves to null in the script; guard results before dereferencing.");
  }
  return buildDeliveryEnvelope({
    header: [
      `Workflow run ${runId}`,
      `Run directory: ${runDir}`,
      `Status: ${error.status}`,
      ...(aborted ? ["The workflow was intentionally stopped. Do not resume it unless the user explicitly asks."] : []),
    ],
    failures: aborted ? failures : [`Error: ${message}`, ...failures],
    recovery: aborted ? [] : [
      `Recovery: workflow({ scriptPath: ${stringifyDeliveryJson(scriptPath)}, resumeRunId: ${stringifyDeliveryJson(runId)} })`,
    ],
    warnings: error.persistenceWarning ? [`Warning: ${safeDeliveryValue(error.persistenceWarning)}`] : [],
    artifacts: [`Run artifacts: ${runDir}`],
    toolActivity: formatToolActivity(workflowActivitySummary(error.runId, error.runDir)),
  });
}

export function completeWorkflow<T>(pi: ExtensionAPI, result: WorkflowRunResult, sessionId: string, deliver: () => T): T {
  recordWorkflowCompleted(pi, result);
  const delivered = deliver();
  if (!writeDeliveryMarker(result.runDir, sessionId, workflowDeliveryIdentity(result.generation))) {
    throw new Error(`Workflow run ${result.runId} changed generation before inline delivery could be recorded`);
  }
  return delivered;
}

export function completeWorkflowFailure<T>(error: unknown, sessionId: string, deliver: (message: string) => T): T {
  try {
    const delivered = deliver(formatWorkflowFailure(error));
    if (error instanceof WorkflowRunError && error.generation !== undefined
      && !writeDeliveryMarker(error.runDir, sessionId, workflowDeliveryIdentity(error.generation))) {
      throw new Error(`Workflow run ${error.runId} changed generation before inline failure delivery could be recorded`);
    }
    return delivered;
  } finally {
    if (error instanceof WorkflowRunError) subagentRunner.releaseRunActivity(error.runId);
  }
}

function recordWorkflowCompleted(pi: ExtensionAPI, result: WorkflowRunResult): void {
  appendEntrySafely(pi, "subagent-workflow:run-completed", {
    runId: result.runId,
    runDir: result.runDir,
    generation: result.generation,
    phases: result.meta.phases ?? [],
  });
}

function workflowDeliveryIdentity(generation: number | undefined): RunDeliveryIdentity {
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Workflow completion has no valid delivery generation");
  }
  return { protocol: DELIVERY_PROTOCOL_VERSION, generation };
}

function validateLiteralModels(models: readonly string[], registry: ParentContext["ctx"]["modelRegistry"]): string | undefined {
  const problems = [...new Set(models
    .map((value) => unknownModelError(value, registry))
    .filter((message): message is string => message !== undefined))];
  if (problems.length === 0) return undefined;
  return `Workflow was not launched; fix the script's model values first. ${problems.join(" ")}`;
}

/** Group identical child failures so 13 copies of one bad model read as one line. */
export function groupFailedChildren(failedChildren: WorkflowRunResult["failedChildren"]): Array<{ count: number; error: string; labels: string[] }> {
  const groups = new Map<string, { count: number; error: string; labels: string[] }>();
  for (const child of failedChildren) {
    const error = child.error ?? "Unknown error";
    const group = groups.get(error) ?? { count: 0, error, labels: [] };
    group.count += 1;
    if (group.labels.length < 3) group.labels.push(child.resolved.label);
    groups.set(error, group);
  }
  return [...groups.values()];
}

function formatGroupedFailures(failedChildren: WorkflowRunResult["failedChildren"]): string[] {
  return groupFailedChildren(failedChildren).map((group) => {
    const labels = `${group.labels.map(safeDeliveryValue).join(", ")}${group.count > group.labels.length ? ", ..." : ""}`;
    return `${group.count} failed child${group.count === 1 ? "" : "ren"} (${labels}): ${safeDeliveryValue(group.error)}`;
  });
}

export function formatWorkflowResult(result: WorkflowRunResult): string {
  try {
    // stringifyDeliveryJson, not raw JSON.stringify: workflow results can
    // carry DEL/C1 controls that must not reach the parent transcript raw.
    const structured = stringifyDeliveryJson({
      type: "workflow_result",
      runId: result.runId,
      runDir: result.runDir,
      status: workflowStatus(result),
      result: result.result,
      ...(result.failedChildren.length === 0 ? {} : { failedChildren: result.failedChildren }),
      ...(result.persistenceWarning === undefined ? {} : { warning: result.persistenceWarning }),
    });
    return structured.length <= DELIVERY_ENVELOPE_BUDGET ? structured : formatWorkflowEnvelope(result);
  } finally {
    subagentRunner.releaseRunActivity(result.runId);
  }
}


const TOOL_ACTIVITY_GROUP_CAP = 64;
const TOOL_ACTIVITY_EXAMPLE_CAP = 5;
const TOOL_ACTIVITY_LABEL_MAX = 60;
/** Byte budget for the activity block inside the 16 KB background delivery. */
const TOOL_ACTIVITY_TEXT_BUDGET = 4_000;

export interface ChildToolActivityExample {
  /** The persisted childId: the unique, stable handle for follow-up. */
  id: string;
  /** The authored label: readable but neither unique nor stable. */
  label: string;
}

export interface ChildToolActivityGroup {
  /** Children sharing exactly this tool profile. */
  count: number;
  /** Up to five member identities; for small runs this is full per-child identity. */
  examples: ChildToolActivityExample[];
  /** Per-child tool-call counts shared by every member of the group. */
  tools: Record<string, number>;
}

export interface ChildToolActivitySummary {
  groups: ChildToolActivityGroup[];
  totalChildren: number;
  /** Children not represented in groups (distinct-profile overflow only). */
  omittedChildren: number;
  /** False when the run records could not be fully read; counts may be missing data. */
  complete: boolean;
}

/**
 * Per-child tool-call counts folded from the run's persisted activity events
 * and grouped by identical tool profile, so the orchestrator can verify what
 * children actually ran instead of trusting their prose. Large fan-outs are
 * usually homogeneous, so grouping keeps the summary complete at any scale
 * while making anomalies stand out: a "research" child that called no tools
 * answered from model memory and surfaces as its own group. Verification
 * data must never lie by omission - overflow beyond the group cap is
 * counted, unreadable records mark the summary incomplete, and a read
 * failure yields an incomplete empty summary rather than an ambiguous empty
 * list. Delivery itself must never fail on this aid.
 */
export function summarizeChildToolActivity(runDir: string): ChildToolActivitySummary {
  try {
    return summarizeActivityFold(activityFoldFromSnapshot(readRunSnapshot(runDir)));
  } catch {
    return { groups: [], totalChildren: 0, omittedChildren: 0, complete: false };
  }
}

export function summarizeActivityFold(fold: RunActivityFold): ChildToolActivitySummary {
  const groups = new Map<string, ChildToolActivityGroup>();
  for (const [id, child] of fold.children) {
    const label = safeDeliveryValue(child.label).slice(0, TOOL_ACTIVITY_LABEL_MAX);
    const key = JSON.stringify(Object.entries(child.tools).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    const group = groups.get(key) ?? { count: 0, examples: [], tools: child.tools };
    group.count += 1;
    // The id is the identity: labels are author-chosen and freely collide,
    // so an anomalous child must be nameable by its unique persisted id.
    if (group.examples.length < TOOL_ACTIVITY_EXAMPLE_CAP) group.examples.push({ id, label });
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((left, right) => right.count - left.count);
  const kept = ordered.slice(0, TOOL_ACTIVITY_GROUP_CAP);
  const omittedChildren = ordered.slice(TOOL_ACTIVITY_GROUP_CAP).reduce((sum, group) => sum + group.count, 0);
  return { groups: kept, totalChildren: fold.children.size, omittedChildren, complete: fold.complete };
}

/**
 * One prose line per profile group, bounded to a byte budget at group
 * boundaries; explicit about partial and incomplete summaries. Anything the
 * budget drops is counted into the omission notice, never silently cut.
 */
export function formatToolActivity(summary: ChildToolActivitySummary, budget = TOOL_ACTIVITY_TEXT_BUDGET): string {
  if (summary.groups.length === 0 && summary.omittedChildren === 0) {
    return summary.complete ? "" : "\nTool activity: unavailable (run records could not be fully read)";
  }
  const lines: string[] = [];
  let bytes = 0;
  let budgetOmittedChildren = 0;
  for (const group of summary.groups) {
    const members = `${group.examples.map((example) => `${example.label} [${example.id}]`).join(", ")}${group.count > group.examples.length ? ", ..." : ""}`;
    const tools = Object.entries(group.tools).map(([tool, count]) => `${tool} x${count}`).join(", ") || "no tool calls";
    const line = group.count === 1 ? `${members}: ${tools}` : `${group.count} children (${members}): ${tools} each`;
    if (budgetOmittedChildren > 0 || bytes + line.length > budget) {
      budgetOmittedChildren += group.count;
      continue;
    }
    lines.push(line);
    bytes += line.length + 2;
  }
  const omittedTotal = summary.omittedChildren + budgetOmittedChildren;
  const omitted = omittedTotal > 0 ? `; ${omittedTotal} more children omitted (fold events.jsonl in the run directory for the rest)` : "";
  const incomplete = summary.complete ? "" : " [incomplete: some run records were unreadable]";
  return `\nTool activity${incomplete}: ${lines.join("; ")}${omitted}`;
}

export function formatWorkflowDelivery(result: WorkflowRunResult): string {
  return formatWorkflowEnvelope(result);
}

function workflowActivitySummary(runId: string, runDir: string): ChildToolActivitySummary {
  const incremental = subagentRunner.runActivityFold(runId);
  return incremental ? summarizeActivityFold(incremental) : summarizeChildToolActivity(runDir);
}

function workflowStatus(result: WorkflowRunResult): string {
  const failedCount = result.failedChildren.length;
  return failedCount === 0 ? "completed" : `completed with ${failedCount} failed child${failedCount === 1 ? "" : "ren"}`;
}

function formatWorkflowEnvelope(result: WorkflowRunResult): string {
  const runId = safeDeliveryValue(result.runId);
  const runDir = safeDeliveryValue(result.runDir);
  const resultJson = stringifyDeliveryJson({ type: "workflow_result", result: result.result });
  const artifact = result.result === undefined ? runDir : `${runDir}/result.json`;
  const failedCount = result.failedChildren.length;
  const status = workflowStatus(result);
  return buildDeliveryEnvelope({
    header: [
      `Workflow run ${runId}`,
      `Run directory: ${runDir}`,
      `Status: ${status}`,
      `Phases: ${stringifyDeliveryJson(result.meta.phases ?? [])}`,
    ],
    failures: formatGroupedFailures(result.failedChildren),
    recovery: failedCount === 0 ? [] : [
      `Recovery: workflow({ scriptPath: ${stringifyDeliveryJson(`${runDir}/script.js`)}, resumeRunId: ${stringifyDeliveryJson(runId)} })`,
    ],
    warnings: result.persistenceWarning ? [`Warning: ${safeDeliveryValue(result.persistenceWarning)}`] : [],
    artifacts: [`Result artifact: ${artifact}`],
    // Activity is already bounded. It remains ahead of the only truncatable
    // section because it is recoverable from events.jsonl, not result.json.
    toolActivity: formatToolActivity(workflowActivitySummary(result.runId, result.runDir)),
    resultPreview: resultJson,
    truncationMarker: `[truncated - full result persisted at ${artifact}]`,
  });
}
