import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  MODEL_DESCRIPTION,
  PublicSubagentOptionFields,
  PublicSubagentSpecSchema,
  SubagentPromptSchema,
  assertSchemaValue,
} from "../subagent-spec.js";
import type { SubagentResult, SubagentSpec, SubagentStatus, ThinkingLevel } from "../types.js";
import { submittedSpec, unknownModelError, type ChildSpawnSpec, type ParentContext, type ResolvedFollowUpSpec } from "../runner/child.js";
import { runOwnerIsLive } from "../store/lease.js";
import {
  DELIVERY_PROTOCOL_VERSION,
  queueAcknowledgedDelivery,
  writeDeliveryMarker,
  type RunDeliveryIdentity,
} from "../store/delivery-marker.js";
import { encodeCwd, sumUsage } from "../store/run-store.js";
import { readRunSnapshot, type RunSnapshot } from "../store/run-snapshot.js";
import { hasSessionClosedMarker } from "../store/session-closed-marker.js";
import { subagentRunner, type SubagentRunner } from "../runner/runner.js";
import {
  SubagentRowTracker,
  initialDetails,
  renderCallHeader,
  renderSubagentResult,
  type SubagentDetails,
  type SubagentRowsState,
} from "../ui/tool-render.js";
import { appendEntrySafely } from "../ui/entry-markers.js";
import { buildDeliveryEnvelope, DELIVERY_ENVELOPE_BUDGET } from "../ui/delivery-envelope.js";
import { safeDeliveryValue, stringifyDeliveryJson } from "../ui/delivery-safe.js";
import type { SubagentStatusWidget } from "../ui/status-widget.js";
import { reportDiagnostic } from "../diagnostics.js";
import { bindAbort, childLabel, errorMessage, isRecord } from "../util.js";
import { groupFailedChildren } from "../workflow/launch.js";

export const SubagentToolParameters = Type.Object({
  prompt: Type.Optional(SubagentPromptSchema),
  ...PublicSubagentOptionFields,
  // Top-level calls represent one child. Fan-out specs intentionally keep
  // empty model strings representable so that child can fail independently.
  model: Type.Optional(Type.String({ minLength: 1, description: MODEL_DESCRIPTION })),
  specs: Type.Optional(Type.Array(PublicSubagentSpecSchema, {
    minItems: 1,
    maxItems: 16,
    description: "Independent child specs. Mutually exclusive with prompt and top-level child options. The process-wide semaphore already limits actual concurrency.",
  })),
  followUp: Type.Optional(Type.Object({
    id: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1 }),
  }, { additionalProperties: false })),
  wait: Type.Optional(Type.Boolean({
    description: "Almost always omit. Waiting blocks the rest of this turn until every child finishes; the user's only recourse is /background or b in /agents, which detaches the run and returns a backgrounded running result - after that, do not poll; the result arrives as a steered message. Prefer background even when later work depends on the result - end the turn and continue when the completion message arrives; do not poll. Set true only for short runs whose result this same turn must consume immediately.",
  })),
}, { additionalProperties: false });
export type SubagentToolInput = Static<typeof SubagentToolParameters>;

const PER_SPEC_FIELDS = Object.keys(PublicSubagentOptionFields) as Array<keyof typeof PublicSubagentOptionFields>;

export type ValidatedSubagentInput =
  | { type: "spawn"; specs: SubagentSpec[] }
  | { type: "followUp"; id: string; prompt: string };

export function validateSubagentInput(params: SubagentToolInput): ValidatedSubagentInput {
  assertSchemaValue(SubagentToolParameters, params, "subagent input");
  const single = params.prompt !== undefined;
  const batch = params.specs !== undefined;
  const followUp = params.followUp !== undefined;
  if (Number(single) + Number(batch) + Number(followUp) !== 1) {
    throw new Error("Provide exactly one of prompt, specs, or followUp");
  }
  if (batch) {
    // Top-level per-spec fields are silently ignored when specs is given; a
    // caller who sets them at the top level meant them per child. Fail loudly.
    const stray = PER_SPEC_FIELDS.find((field) => params[field] !== undefined);
    if (stray) throw new Error(`With specs, set ${stray} inside each specs entry, not at the top level`);
  }
  if (followUp) {
    const stray = PER_SPEC_FIELDS.find((field) => params[field] !== undefined);
    if (stray) throw new Error(`With followUp, ${stray} is invalid at the top level`);
    if (!params.followUp!.prompt.trim()) throw new Error("Subagent prompt must not be empty");
    return { type: "followUp", id: params.followUp!.id, prompt: params.followUp!.prompt };
  }
  const specs: SubagentSpec[] = batch ? (params.specs as SubagentSpec[]) : [{ prompt: params.prompt!, model: params.model,
    thinkingLevel: params.thinkingLevel as ThinkingLevel | undefined, tools: params.tools, excludeTools: params.excludeTools,
    schema: params.schema, cwd: params.cwd, label: params.label, isolation: params.isolation }];
  // TypeBox's minLength does not catch whitespace-only prompts.
  for (const spec of specs) if (!spec.prompt.trim()) throw new Error("Subagent prompt must not be empty");
  return { type: "spawn", specs };
}

interface FollowUpCandidate {
  runId: string;
  runDir: string;
  childId: string;
  createdAt: number;
  child: Record<string, unknown>;
  status: unknown;
  generationPending: boolean;
  requiresSessionClosedMarker: boolean;
}

interface FollowUpPersistenceReads {
  readRecord(runDir: string): unknown;
  readSnapshot(runDir: string): RunSnapshot;
}

const FOLLOW_UP_PERSISTENCE_READS: FollowUpPersistenceReads = {
  readRecord: (runDir) => {
    try {
      return JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    } catch {
      return undefined;
    }
  },
  readSnapshot: readRunSnapshot,
};

export function resolveFollowUpSpec(
  id: string,
  prompt: string,
  cwd: string,
  runsRoot: string = join(getAgentDir(), "subagent-workflow", "runs"),
  reads: FollowUpPersistenceReads = FOLLOW_UP_PERSISTENCE_READS,
): ResolvedFollowUpSpec {
  const qualified = parseQualifiedFollowUpId(id);
  const runRoot = join(runsRoot, encodeCwd(cwd));
  const candidates: FollowUpCandidate[] = [];
  let entries: string[];
  if (qualified) {
    entries = [qualified.runId];
  } else {
    try {
      entries = readdirSync(runRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
      else throw error;
    }
    entries = entries.filter((runId) => recordHasChild(reads.readRecord(join(runRoot, runId)), id));
  }
  for (const runId of entries) {
    const runDir = join(runRoot, runId);
    const snapshot = reads.readSnapshot(runDir);
    const record = jsonObject(snapshot.record);
    if (!record || !Array.isArray(record.children)) continue;
    const createdAt = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : NaN;
    const statusChildren = jsonObject(jsonObject(snapshot.status)?.children);
    for (const value of record.children) {
      const child = jsonObject(value);
      const childId = typeof child?.id === "string" ? child.id : undefined;
      if (!childId || childId !== (qualified?.childId ?? id)) continue;
      let status = jsonObject(statusChildren?.[childId])?.status;
      if (isLiveStatus(status) && !runOwnerIsLive(runDir)) {
        status = terminalStatusFromEvents(snapshot.events, childId) ?? "aborted";
      }
      candidates.push({
        runId,
        runDir,
        childId,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        child: child as Record<string, unknown>,
        status,
        generationPending: snapshot.generationPending,
        requiresSessionClosedMarker: record.v === 3,
      });
    }
  }
  candidates.sort((left, right) => right.createdAt - left.createdAt || right.runId.localeCompare(left.runId));
  if (candidates.length === 0) {
    throw new Error(`No child ${JSON.stringify(id)} was found in persisted runs for ${cwd}`);
  }
  if (!qualified && candidates.length > 1) {
    throw new Error(`Child id ${JSON.stringify(id)} is ambiguous; use one of: ${candidates.map(candidateName).join(", ")}`);
  }
  const candidate = candidates[0]!;
  if (candidate.generationPending) {
    throw new Error(`Cannot follow up ${candidateName(candidate)}: source run is quarantined by generation.pending`);
  }
  if (!isTerminalStatus(candidate.status)) {
    throw new Error(`Cannot follow up ${candidateName(candidate)}: child is not terminal (status: ${String(candidate.status ?? "missing")})`);
  }
  const submitted = jsonObject(candidate.child.spec);
  const resolved = jsonObject(candidate.child.resolved);
  if (!submitted || !resolved) {
    throw new Error(`Cannot follow up ${candidateName(candidate)}: persisted child spec or resolved configuration is missing`);
  }
  if (submitted.isolation === "worktree" || typeof resolved.worktreePath === "string") {
    throw new Error(`Cannot follow up ${candidateName(candidate)}: worktree-origin children cannot be continued because their conversation references a checkout that no longer exists`);
  }
  const sessionFile = candidate.child.sessionFile;
  if (typeof sessionFile !== "string" || !sessionFile) {
    throw new Error(`Cannot follow up ${candidateName(candidate)}: persisted sessionFile is missing`);
  }
  if (!isAbsolute(sessionFile)) {
    throw new Error(`Cannot follow up ${candidateName(candidate)}: persisted sessionFile must be an absolute path`);
  }
  if (!existsSync(sessionFile)) {
    throw new Error(`Cannot follow up ${candidateName(candidate)}: persisted sessionFile is missing`);
  }
  if (candidate.requiresSessionClosedMarker && !hasSessionClosedMarker(candidate.runDir, candidate.childId)) {
    throw new Error(`Cannot follow up ${candidateName(candidate)}: source session closure is not confirmed; wait for child shutdown to finish and retry`);
  }
  const provider = requiredString(resolved.provider, candidate, "resolved provider");
  const modelId = requiredString(resolved.modelId, candidate, "resolved modelId");
  const thinkingLevel = resolved.thinkingLevel;
  if (!isThinkingLevel(thinkingLevel)) {
    throw new Error(`Cannot follow up ${candidateName(candidate)}: persisted thinkingLevel is invalid`);
  }
  const inheritedTools = optionalStringArray(submitted.tools, candidate, "tools");
  const tools = submitted.schema === undefined
    ? inheritedTools
    : inheritedTools?.filter((tool) => tool !== "report_result");
  const excludeTools = optionalStringArray(submitted.excludeTools, candidate, "excludeTools");
  const submittedCwd = optionalString(submitted.cwd, candidate, "cwd");
  const label = optionalString(submitted.label, candidate, "label");
  return {
    spec: {
      prompt,
      model: `${provider}/${modelId}`,
      thinkingLevel,
      ...(tools === undefined ? {} : { tools }),
      ...(excludeTools === undefined ? {} : { excludeTools }),
      ...(submittedCwd === undefined ? {} : { cwd: submittedCwd }),
      ...(label === undefined ? {} : { label }),
    },
    forkSessionFile: sessionFile,
    followUpOf: { runId: candidate.runId, childId: candidate.childId },
  };
}

function parseQualifiedFollowUpId(id: string): { runId: string; childId: string } | undefined {
  const parts = id.split("/");
  return parts.length === 2 && parts[0] && parts[1] ? { runId: parts[0], childId: parts[1] } : undefined;
}

function recordHasChild(value: unknown, childId: string): boolean {
  const children = jsonObject(value)?.children;
  return Array.isArray(children)
    && children.some((child) => jsonObject(child)?.id === childId);
}

function candidateName(candidate: Pick<FollowUpCandidate, "runId" | "childId">): string {
  return `${candidate.runId}/${candidate.childId}`;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isLiveStatus(value: unknown): value is Extract<SubagentStatus, "pending" | "running"> {
  return value === "pending" || value === "running";
}

function isTerminalStatus(value: unknown): value is Extract<SubagentStatus, "completed" | "failed" | "aborted"> {
  return value === "completed" || value === "failed" || value === "aborted";
}

function terminalStatusFromEvents(events: readonly unknown[], childId: string): Extract<SubagentStatus, "completed" | "failed" | "aborted"> | undefined {
  let terminal: Extract<SubagentStatus, "completed" | "failed" | "aborted"> | undefined;
  for (const value of events) {
    const event = jsonObject(value);
    if (event?.id !== childId) continue;
    const result = event.type === "result" ? jsonObject(event.result) : undefined;
    const status = event.type === "status" ? event.status : result?.status;
    if (isTerminalStatus(status)) terminal = status;
  }
  return terminal;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium"
    || value === "high" || value === "xhigh" || value === "max";
}

function requiredString(value: unknown, candidate: FollowUpCandidate, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Cannot follow up ${candidateName(candidate)}: persisted ${field} is invalid`);
}

function optionalString(value: unknown, candidate: FollowUpCandidate, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new Error(`Cannot follow up ${candidateName(candidate)}: persisted ${field} is invalid`);
}

function optionalStringArray(value: unknown, candidate: FollowUpCandidate, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [...value];
  throw new Error(`Cannot follow up ${candidateName(candidate)}: persisted ${field} is invalid`);
}

type Detailed = AgentToolResult<SubagentDetails | undefined>;
type FollowUpResolver = (id: string, prompt: string, cwd: string) => ResolvedFollowUpSpec;

export function registerSubagentTool(pi: ExtensionAPI, selfPath: string, widget?: SubagentStatusWidget,
  runner: SubagentRunner = subagentRunner, resolveFollowUp: FollowUpResolver = resolveFollowUpSpec): void {
  const tool: ToolDefinition<typeof SubagentToolParameters, SubagentDetails | undefined, SubagentRowsState> = {
    name: "subagent", label: "Subagent", parameters: SubagentToolParameters,
    description: "Spawn one ad-hoc child or fan out up to 16 independent children; when results must feed later spawns or there are more than 16 items, use workflow instead. Each child starts cold with only its self-contained prompt and inherits the parent's provider/model and thinking level unless overridden ('provider/model-id', never a bare model name). Add schema (JSON Schema) for validated structured output. Use isolation: 'worktree' for parallel edits; changes return as a patch, never applied automatically. Do not pre-batch to control concurrency; the global semaphore already paces all spawns. Background delivery is the default; the result arrives as a steered message. With wait: true, an under-budget result is JSON shaped as { type: \"subagent_results\", runId, runDir, results }, plus warning when persistence degraded; oversized results use the bounded prose envelope. followUp: { id, prompt } forks a completed child's persisted session into a new child and run. Compose each child for the task at hand; recurring task shapes belong in skills, not fixed agent personas.",
    async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<Detailed> {
      let input: ValidatedSubagentInput;
      try { input = validateSubagentInput(params); } catch (error) { throw new Error(errorMessage(error)); }
      const spawnSpecs: ChildSpawnSpec[] = input.type === "followUp"
        ? [resolveFollowUp(input.id, input.prompt, ctx.cwd)]
        : input.specs;
      const specs = spawnSpecs.map(submittedSpec);
      // A call whose every child is doomed by an unknown model fails fast with
      // a suggestion instead of spawning. A mixed fan-out still spawns: one bad
      // spec must not kill valid siblings (their entries fail individually,
      // carrying the same suggestion), per the batch-isolation contract.
      const modelProblems = specs
        .map((spec) => spec.model === undefined ? undefined : unknownModelError(spec.model, ctx.modelRegistry))
        .filter((problem): problem is string => problem !== undefined);
      if (modelProblems.length === specs.length) {
        throw new Error([...new Set(modelProblems)].join(" "));
      }
      const parent: ParentContext = { ctx, thinkingLevel: pi.getThinkingLevel() as ThinkingLevel, selfPath };
      const handles = runner.spawnRun(spawnSpecs, parent);
      const runId = handles[0]!.runId;
      const runDir = handles[0]!.runDir;
      const fanout = specs.length > 1;
      appendEntrySafely(pi, "subagent-workflow:run-started", {
        runId,
        runDir,
        childIds: handles.map((handle) => handle.id),
        labels: specs.map((spec) => spec.label ?? childLabel(spec)),
      });
      try {
        widget?.track(runId, handles, fanout, ctx);
      } catch (error) {
        // The status widget is observational. Delivery and runner cleanup must
        // remain wired even if a host UI implementation rejects the widget.
        reportDiagnostic(`[subagent-workflow] status widget failed: ${errorMessage(error)}`);
      }
      if (params.wait) {
        // Only a waiting call is bound to this turn's signal: if the user
        // interrupts while we block on the result, cancel the children.
        // Background children deliberately outlive the spawning turn, so they
        // are NOT wired to it (a later Esc must not kill promised work).
        const onAbort = () => { for (const handle of handles) void handle.abort(); };
        const unbindAbort = bindAbort(signal, onAbort);
        const tracker = ctx.hasUI ? new SubagentRowTracker(fanout) : undefined;
        const stopStream = tracker ? streamRows(onUpdate, tracker, handles) : undefined;
        const sessionId = ctx.sessionManager.getSessionId();
        let outcome: "waiting" | "completed" | "detached" = "waiting";
        const claim = (next: "completed" | "detached"): boolean => {
          if (outcome !== "waiting") return false;
          outcome = next;
          return true;
        };
        let requestDetach!: () => void;
        const detachRequested = new Promise<void>((resolve) => { requestDetach = resolve; });
        runner.registerWaitedRun(runId, sessionId, () => {
          if (signal?.aborted || !claim("detached")) return false;
          unbindAbort();
          stopStream?.();
          requestDetach();
          return true;
        });
        const allResults = Promise.all(handles.map((handle) => handle.result));
        try {
          const settled = await Promise.race([
            allResults.then((results) => claim("completed") ? { results } : undefined),
            detachRequested.then(() => undefined),
          ]);
          if (settled) {
            stopStream?.();
            return completeInlineRun(pi, runner, runId, runDir, handles, settled.results, sessionId, (degraded) => {
              const text = formatWaitResult(runId, runDir, settled.results, degraded);
              return detailedResult(text, tracker?.snapshot(handles));
            });
          }
        } finally {
          runner.unregisterWaitedRun(runId);
          unbindAbort();
        }
        void allResults.then((results) => {
          queueCompletedRun(pi, runner, runId, runDir, handles, results, sessionId);
        }).catch((error) => {
          reportDiagnostic(`[subagent-workflow] background delivery failed: ${errorMessage(error)}`);
        });
        return detachedResult(runId, runDir, tracker?.snapshot(handles));
      }
      const launched = ctx.hasUI ? initialDetails(specs, handles, fanout) : undefined;
      void Promise.all(handles.map((handle) => handle.result)).then((results) => {
        queueCompletedRun(pi, runner, runId, runDir, handles, results, ctx.sessionManager.getSessionId());
      }).catch((error) => {
        reportDiagnostic(`[subagent-workflow] background delivery failed: ${errorMessage(error)}`);
      });
      return detailedResult(JSON.stringify(handles.length === 1
        ? { id: handles[0]!.id, runId, runDir, status: handles[0]!.status, label: specs[0]!.label }
        : handles.map((handle, index) => ({ id: handle.id, status: handle.status, label: specs[index]!.label }))), launched);
    },
    renderCall(args, theme) {
      if (args.followUp) {
        return renderCallHeader({ fanout: false, count: 1, label: `follow-up · ${args.followUp.id}` }, theme);
      }
      const fanout = Array.isArray(args.specs) && args.specs.length > 1;
      const count = fanout ? args.specs!.length : 1;
      const label = args.label ?? (args.prompt ? childLabel({ prompt: args.prompt }) : "Subagent");
      return renderCallHeader({ fanout, count, label }, theme);
    },
    renderResult(result, options, theme, context) {
      return renderSubagentResult(result.details, options, theme, context.state ??= {}, context.invalidate, context.lastComponent);
    },
  };
  pi.registerTool(tool);
}

/** Subscribe to child events and stream a throttled (~10Hz) details snapshot to the tool row. */
function streamRows(onUpdate: ((result: Detailed) => void) | undefined, tracker: SubagentRowTracker, handles: ReturnType<SubagentRunner["spawnRun"]>): () => void {
  let pending: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let unsubscribers: Array<() => void> = [];
  const stop = (): void => {
    if (!active) return;
    active = false;
    if (pending) { clearTimeout(pending); pending = undefined; }
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    unsubscribers = [];
  };
  const flush = (): void => {
    pending = undefined;
    if (!active) return;
    try {
      onUpdate?.({ content: [{ type: "text", text: handles.map((handle) => `${handle.id}: ${handle.status}`).join("\n") }], details: tracker.snapshot(handles) });
    } catch (error) {
      reportDiagnostic(`[subagent-workflow] tool-row update failed: ${errorMessage(error)}`);
      stop();
    }
  };
  unsubscribers = handles.map((handle) => handle.subscribe((event) => {
    if (!active) return;
    try {
      tracker.observe(event);
      if (!pending) pending = setTimeout(flush, 100);
    } catch (error) {
      reportDiagnostic(`[subagent-workflow] tool-row tracking failed: ${errorMessage(error)}`);
      stop();
    }
  }));
  return stop;
}

function detailedResult(text: string, details: SubagentDetails | undefined): Detailed {
  return { content: [{ type: "text", text }], details };
}

function detachedResult(runId: string, runDir: string, details: SubagentDetails | undefined): Detailed {
  return detailedResult(JSON.stringify({
    type: "subagent_backgrounded",
    runId,
    runDir,
    status: "running",
    note: "The user moved this run to the background. Do not wait or poll; the result will arrive as a steered message. Continue other work or end the turn.",
  }), details);
}

export function formatWaitResult(runId: string, runDir: string, results: SubagentResult[], degraded?: string): string {
  // stringifyDeliveryJson, not raw JSON.stringify: child text can carry DEL/C1
  // controls that would otherwise reach the parent transcript unescaped.
  const structured = stringifyDeliveryJson({
    type: "subagent_results",
    runId,
    runDir,
    results,
    ...(degraded === undefined ? {} : { warning: degraded }),
  });
  return structured.length <= DELIVERY_ENVELOPE_BUDGET ? structured : formatDelivery(runId, runDir, results, degraded);
}

export function formatDelivery(runId: string, runDir: string, results: SubagentResult[], degraded?: string): string {
  const safeRunId = safeDeliveryValue(runId);
  const safeRunDir = safeDeliveryValue(runDir);
  const deliveredResults = results.map((result) => ({
    ...result,
    id: safeDeliveryValue(result.id),
    ...(result.sessionFile === undefined ? {} : { sessionFile: safeDeliveryValue(result.sessionFile) }),
    resolved: { ...result.resolved, label: safeDeliveryValue(result.resolved.label) },
    ...(result.error === undefined ? {} : { error: safeDeliveryValue(result.error) }),
  }));
  const completedCount = deliveredResults.filter((result) => result.status === "completed").length;
  const failedCount = deliveredResults.filter((result) => result.status === "failed").length;
  const abortedCount = deliveredResults.filter((result) => result.status === "aborted").length;
  const status = results.length === 1
    ? deliveredResults[0]!.status
    : [
      completedCount > 0 ? "completed" : undefined,
      failedCount > 0 ? `${failedCount} failed child${failedCount === 1 ? "" : "ren"}` : undefined,
      abortedCount > 0 ? `${abortedCount} aborted` : undefined,
    ].filter((part): part is string => part !== undefined).join(", ");
  const failureGroups = groupFailedChildren(deliveredResults.filter((result) => result.status === "failed")).map((group) => {
    const labels = `${group.labels.join(", ")}${group.count > group.labels.length ? ", ..." : ""}`;
    return `${group.count} failed child${group.count === 1 ? "" : "ren"} (${labels}): ${group.error}`;
  });
  for (const result of deliveredResults.filter((entry) => entry.status === "aborted")) {
    failureGroups.push(`Aborted child ${result.id} (${result.resolved.label})`);
  }
  const runRecord = `${safeRunDir}/run.json`;
  const eventsRecord = `${safeRunDir}/events.jsonl`;
  return buildDeliveryEnvelope({
    header: [
      `Subagent run ${safeRunId}`,
      `Run directory: ${safeRunDir}`,
      `Status: ${status}`,
      ...deliveredResults.map((result) => `Child ${result.id} (${result.resolved.label}): ${result.status}`),
    ],
    failures: failureGroups,
    recovery: failedCount > 0 ? ["Recovery: respawn failed children with the same prompts and options."] : [],
    warnings: degraded ? [`Warning: run persistence degraded (${safeDeliveryValue(degraded)}); the run directory may be incomplete`] : [],
    artifacts: [`Run record: ${runRecord}`],
    auxiliaryArtifacts: deliveredResults
      .filter((result) => result.sessionFile !== undefined)
      .map((result) => `Child ${result.id} session: ${result.sessionFile}`),
    resultPreview: stringifyDeliveryJson({ type: "subagent_results", results: deliveredResults }),
    truncationMarker: degraded
      ? `[truncated - result may be incomplete at ${eventsRecord}; run persistence degraded]`
      : `[truncated - full result remains available via ${eventsRecord}]`,
  });
}

function completeInlineRun<T>(pi: ExtensionAPI, runner: SubagentRunner, runId: string, runDir: string,
  handles: ReturnType<SubagentRunner["spawnRun"]>, results: SubagentResult[], sessionId: string,
  deliver: (degraded: string | undefined) => T): T {
  recordCompletedRun(pi, runId, runDir, handles, results);
  const identity = resultDeliveryIdentity(runId, results);
  const delivered = deliver(runner.markDelivered(runId));
  if (!writeDeliveryMarker(runDir, sessionId, identity)) {
    throw new Error(`Run ${runId} changed generation before inline delivery could be recorded`);
  }
  return delivered;
}

function queueCompletedRun(pi: ExtensionAPI, runner: SubagentRunner, runId: string, runDir: string,
  handles: ReturnType<SubagentRunner["spawnRun"]>, results: SubagentResult[], sessionId: string): void {
  recordCompletedRun(pi, runId, runDir, handles, results);
  const identity = resultDeliveryIdentity(runId, results);
  const message = formatDelivery(runId, runDir, results, runner.finalizedRunWarning(runId));
  queueAcknowledgedDelivery(pi, {
    sessionId,
    message,
    targets: [{ runDir, identity }],
  });
  runner.markDelivered(runId);
}

function recordCompletedRun(pi: ExtensionAPI, runId: string, runDir: string,
  handles: ReturnType<SubagentRunner["spawnRun"]>, results: SubagentResult[]): void {
  const durationMs = Date.now() - Math.min(...handles.map((handle) => handle.startedAt));
  appendEntrySafely(pi, "subagent-workflow:run-completed", {
    runId,
    runDir,
    generation: resultDeliveryIdentity(runId, results).generation,
    perChild: results.map((result) => ({ id: result.id, status: result.status, label: result.resolved.label })),
    usageTotals: sumUsage(results.map((result) => result.usage)),
    durationMs,
  });
}

function resultDeliveryIdentity(runId: string, results: readonly SubagentResult[]): RunDeliveryIdentity {
  const generations = new Set(results.map((result) => result.generation));
  if (generations.size !== 1) throw new Error(`Run ${runId} completed with mixed delivery generations`);
  const generation = results[0]?.generation;
  if (!Number.isSafeInteger(generation) || generation! < 1) {
    throw new Error(`Run ${runId} completed without a valid delivery generation`);
  }
  return { protocol: DELIVERY_PROTOCOL_VERSION, generation: generation! };
}
