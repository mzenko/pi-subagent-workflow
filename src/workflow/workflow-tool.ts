import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { ParentContext } from "../runner/child.js";
import { subagentRunner } from "../runner/runner.js";
import type { ThinkingLevel, WorkflowPhase } from "../types.js";
import { sanitizeTerminalText, sanitizeTerminalTextChunks, UNTRUSTED_FIELD_MAX } from "../ui/sanitize.js";
import { reportDiagnostic } from "../diagnostics.js";
import { bindAbort, errorMessage } from "../util.js";
import type { ApproveLaunch, LaunchOrigin, LaunchPlan, WorkflowApprovalPolicy } from "./approval.js";
import type { ConsentStore } from "./consent.js";
import { completeWorkflow, completeWorkflowFailure, deliverWorkflowInBackground, formatWorkflowResult, groupFailedChildren, launchWorkflow, type StartedWorkflow } from "./launch.js";
import { normalizeArgs, readAbsoluteScript, type WorkflowRunResult } from "./workflow-runner.js";
import { parseWorkflowScript } from "./parser.js";

const WorkflowToolParameters = Type.Object({
  script: Type.Optional(Type.String({
    description: "Inline workflow module source, or @<saved-name>. Provide exactly one of script or scriptPath, including when resuming.",
  })),
  scriptPath: Type.Optional(Type.String({
    description: "Absolute path to a workflow module. Provide exactly one of script or scriptPath, including when resuming.",
  })),
  args: Type.Optional(Type.Unknown({
    description: "JSON-serializable deterministic input exposed as deep-frozen args. On resume, omit to reuse persisted args; an explicit value overrides them.",
  })),
  resumeRunId: Type.Optional(Type.String({
    description: "Existing workflow run id to resume with the supplied script or scriptPath; matching successful agent calls replay.",
  })),
  rerunChildIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description: "Resume-only child ids explicitly authorized to rerun after execution-environment drift.",
  })),
  wait: Type.Optional(Type.Boolean({
    description: "Almost always omit. Waiting blocks the rest of this turn until the workflow finishes; the user's only recourse is /background or b in /agents, which detaches the run and returns a backgrounded running result - after that, do not poll; the result arrives as a steered message. Prefer background even when later work depends on the result - end the turn and continue when the completion message arrives; do not poll. Set true only for short runs whose result this same turn must consume immediately.",
  })),
}, { additionalProperties: false });

type WorkflowToolInput = Static<typeof WorkflowToolParameters>;

/** The launch-approval + saved-workflow seams, injected so the tool stays testable. */
interface WorkflowToolServices {
  consent: ConsentStore;
  approve: ApproveLaunch;
  approvalPolicy: () => WorkflowApprovalPolicy;
  observeRun?: (run: StartedWorkflow, ctx: ExtensionContext) => void;
  /** Resolve a `@<name>` reference to a saved workflow script, or undefined if none. */
  resolveSaved: (name: string, cwd: string) => string | undefined;
}

const DESCRIPTION = `Execute deterministic JavaScript orchestration over subagents. Use workflow when results feed later spawns, when you need phases, pipelines, or resumable control flow, or for more than 16 independent items; a plain subagent fan-out (up to 16) covers independent one-shot tasks. Read the workflow-authoring skill before writing a non-trivial script or diagnosing a replay error; launch and runtime errors also name the exact rule violated.

The script is a module string beginning with a literal header:
export const meta = { name: 'audit-routes', description: 'Audit routes', phases: [{ title: 'Discover' }, { title: 'Audit' }] }
const result = await agent('List route files', { schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'], additionalProperties: false } })
const files = result?.files.filter(Boolean) ?? []
phase('Audit')
return parallel(files.map(file => () => agent('Audit ' + file)))

Globals: agent(prompt, opts?), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), and args. agent opts: model ("provider/model-id", never bare), thinkingLevel, tools, excludeTools, schema, cwd, isolation ('worktree' returns { value, patch, changed }; the patch is never applied automatically), label, phase. Every prompt must be self-contained: the child receives neither the parent conversation nor workflow variables unless interpolated. A failed agent() resolves to null - guard before dereferencing. Scripts must be deterministic: no wall-clock, randomness, or raw Promise concurrency - use parallel/pipeline and pass varying inputs through args. Resume with resumeRunId replays completed calls from the journal; drift on a completed call fails closed with an error naming the childId and the rerunChildIds recovery.

Runs in the background by default; completion arrives as a steered parent message. With wait: true, an under-budget result is JSON shaped as { type: "workflow_result", runId, runDir, status, result }, plus failedChildren when agent() calls failed and warning when persistence degraded; oversized results use the bounded prose envelope. Saved workflows run via script: "@<name>" or /wf-<name>. A resumeRunId still requires exactly one of script or scriptPath.`;

/** UI-side summary rendered for the workflow tool row; the model reads content, not this. */
export interface WorkflowToolDetails {
  status: "running" | "completed";
  runId: string;
  runDir: string;
  phases: WorkflowPhase[];
  resultPreview?: string;
  resultBytes?: number;
  failureGroups?: Array<{ count: number; error: string; labels: string[] }>;
  persistenceWarning?: string;
}

export function workflowToolDetails(result: WorkflowRunResult): WorkflowToolDetails {
  const resultJson = result.result === undefined ? undefined : JSON.stringify(result.result);
  return {
    status: "completed",
    runId: result.runId,
    runDir: result.runDir,
    phases: (result.meta.phases ?? []).map((phase) => ({ ...phase })),
    resultPreview: resultJson?.slice(0, 200),
    resultBytes: resultJson?.length,
    failureGroups: groupFailedChildren(result.failedChildren),
    persistenceWarning: result.persistenceWarning,
  };
}

/**
 * Compact tool-row summary. The full result JSON travels to the model in the
 * tool result content; rendering it verbatim floods the transcript, so the
 * row shows counts, a bounded preview, grouped failures, and the run dir.
 */
export function workflowSummaryLines(details: WorkflowToolDetails): string[] {
  const safe = (value: string | number): string => sanitizeTerminalText(String(value));
  const lines: string[] = [];
  lines.push(`${safe(details.runId)} - ${safe(details.status)}`);
  if (details.phases.length > 0) {
    const phases = details.phases.map((phase) => safe(phase.title));
    lines.push(`phases: ${phases.join(", ")}`);
  }
  if (details.resultPreview !== undefined) {
    const truncated = (details.resultBytes ?? 0) > details.resultPreview.length;
    const notice = truncated ? ` [preview of ${safe(details.resultBytes ?? 0)} bytes]` : "";
    lines.push(`result: ${safe(details.resultPreview)}${notice}`);
  }
  for (const group of details.failureGroups ?? []) {
    const safeLabels = group.labels.map(safe);
    const labels = `${safeLabels.join(", ")}${group.count > group.labels.length ? ", ..." : ""}`;
    lines.push(`${safe(group.count)} failed (${labels}): ${safe(group.error)}`);
  }
  if (details.persistenceWarning) lines.push(`warning: ${safe(details.persistenceWarning)}`);
  lines.push(`run dir: ${safe(details.runDir)}`);
  return lines;
}

export function registerWorkflowTool(pi: ExtensionAPI, selfPath: string, services: WorkflowToolServices): void {
  const tool: ToolDefinition<typeof WorkflowToolParameters, WorkflowToolDetails | undefined> = {
    name: "workflow",
    label: "Workflow",
    description: DESCRIPTION,
    parameters: WorkflowToolParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<WorkflowToolDetails | undefined>> {
      const { script, origin } = resolveScriptSource(params, ctx.cwd, services);
      const parsed = parseWorkflowScript(script);
      // Undefined means "reuse persisted args" on resume. Converting it to
      // null here would make the documented recovery invocation hash-miss.
      const args = normalizeWorkflowToolArgs(params.args);
      const plan: LaunchPlan = { workflow: parsed, args, origin };
      const parent: ParentContext = {
        ctx,
        thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
        selfPath,
      };
      const waitController = params.wait ? new AbortController() : undefined;
      const unbindWaitSignal = waitController ? bindAbort(signal, () => waitController.abort()) : () => {};
      let returned = false;
      let launched: Awaited<ReturnType<typeof launchWorkflow>>;
      try {
        launched = await launchWorkflow(
          pi,
          parent,
          // Only a waiting workflow is bound to this turn's signal. A background
          // workflow outlives the turn, so a later Esc must not abort it - stop it
          // from /agents instead.
          {
            plan,
            resumeRunId: params.resumeRunId,
            rerunChildIds: params.rerunChildIds,
            signal: waitController?.signal,
            onLog: (message) => {
              if (!returned) onUpdate?.({ content: [{ type: "text", text: message }], details: undefined });
            },
          },
          { approve: services.approve, ctx, deps: { consent: services.consent, policy: services.approvalPolicy() } },
        );
      } catch (error) {
        unbindWaitSignal();
        throw error;
      }
      const { started, execution } = launched;
      try {
        services.observeRun?.(started, ctx);
      } catch (error) {
        reportDiagnostic(`[subagent-workflow] workflow observer failed: ${sanitizeTerminalText(errorMessage(error))}`);
      }
      if (params.wait) {
        const sessionId = ctx.sessionManager.getSessionId();
        let outcome: "waiting" | "completed" | "detached" = "waiting";
        const claim = (next: "completed" | "detached"): boolean => {
          if (outcome !== "waiting") return false;
          outcome = next;
          return true;
        };
        let requestDetach!: () => void;
        const detachRequested = new Promise<void>((resolve) => { requestDetach = resolve; });
        subagentRunner.registerWaitedRun(started.runId, sessionId, () => {
          if (waitController!.signal.aborted || !claim("detached")) return false;
          unbindWaitSignal();
          requestDetach();
          return true;
        });
        let settled: { ok: WorkflowRunResult } | { err: unknown } | undefined;
        try {
          settled = await Promise.race([
            execution.then(
              (result) => claim("completed") ? { ok: result } : undefined,
              (error) => claim("completed") ? { err: error } : undefined,
            ),
            detachRequested.then(() => undefined),
          ]);
        } finally {
          subagentRunner.unregisterWaitedRun(started.runId);
          unbindWaitSignal();
        }
        if (settled === undefined) {
          returned = true;
          deliverWorkflowInBackground(pi, execution, sessionId);
          return {
            content: [{ type: "text", text: JSON.stringify({
              type: "workflow_backgrounded",
              runId: started.runId,
              runDir: started.runDir,
              status: "running",
              note: "The user moved this workflow to the background. Do not wait or poll; the result will arrive as a steered message. Continue other work or end the turn.",
            }) }],
            details: { status: "running", runId: started.runId, runDir: started.runDir, phases: started.phases },
          };
        }
        if ("err" in settled) throw completeWorkflowFailure(settled.err, sessionId, (message) => new Error(message));
        return completeWorkflow(pi, settled.ok, sessionId, () => ({
          content: [{ type: "text" as const, text: formatWorkflowResult(settled.ok) }],
          details: workflowToolDetails(settled.ok),
        }));
      }
      deliverWorkflowInBackground(pi, execution, ctx.sessionManager.getSessionId());
      returned = true;
      return {
        content: [{ type: "text", text: JSON.stringify({ runId: started.runId, runDir: started.runDir, phases: started.phases, status: "running" }) }],
        details: { status: "running", runId: started.runId, runDir: started.runDir, phases: started.phases },
      };
    },
    renderResult(result, _options, theme) {
      const textParts = (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
      const lines = result.details
        ? workflowSummaryLines(result.details).map((line, index) => index === 0 ? line : theme.fg("dim", line))
        : textParts.length === 0
          ? []
          : sanitizeTerminalTextChunks(textParts, UNTRUSTED_FIELD_MAX, true).split("\n");
      return {
        render: (width) => lines.map((line) => truncateToWidth(line, width)),
        invalidate: () => {},
      };
    },
  };
  pi.registerTool(tool);
}

export function normalizeWorkflowToolArgs(args: unknown): unknown {
  return args === undefined ? undefined : normalizeArgs(args);
}

const SAVED_REFERENCE = /^@([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function resolveScriptSource(params: WorkflowToolInput, cwd: string, services: Pick<WorkflowToolServices, "resolveSaved">): { script: string; origin: LaunchOrigin } {
  const hasScript = params.script !== undefined;
  const hasPath = params.scriptPath !== undefined;
  if (hasScript === hasPath) throw new Error("Provide exactly one of workflow script or scriptPath; resumeRunId does not replace the script");
  if (hasPath) return { script: readAbsoluteScript(params.scriptPath!), origin: "inline" };
  const reference = params.script!.trim().match(SAVED_REFERENCE);
  if (reference) {
    const saved = services.resolveSaved(reference[1]!, cwd);
    if (saved === undefined) throw new Error(`No saved workflow named "${reference[1]}" was found in this project or user scope`);
    return { script: saved, origin: "saved" };
  }
  return { script: params.script!, origin: "inline" };
}
