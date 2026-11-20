import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { subagentRunner, type SubagentRunner } from "../runner/runner.js";
import { assertSchemaValue } from "../subagent-spec.js";
import type { ParentStopReceipt } from "../types.js";
import { linesComponent } from "../ui/component.js";
import { sanitizeTerminalTextChunks, UNTRUSTED_FIELD_MAX } from "../ui/sanitize.js";
import { renderCallHeader } from "../ui/tool-render.js";
import { errorMessage } from "../util.js";

export const SubagentStopToolParameters = Type.Object({
  id: Type.String({ minLength: 1, description: "A subagent's id or runId, or a workflow's runId, from the tool receipt." }),
}, { additionalProperties: false });
export type SubagentStopToolInput = Static<typeof SubagentStopToolParameters>;

const DESCRIPTION = "Stop a running subagent or workflow that this session started - for example when the user asks to cancel it, or its work is no longer needed. Pass a subagent's id or runId, or a workflow's runId. A workflow stops as a whole: its loop is cancelled and every live child is aborted. The call returns once the run has stopped. Its aborted result is still delivered later as a message, with any partial output; do not respawn or resume it unless the user asks. If the subagent had already finished its work, the call reports status already-finished and its normal result arrives as usual; if it ignored the stop and had to be killed, it reports terminated.";

const NOTES: Partial<Record<ParentStopReceipt["status"], string>> = {
  "already-finished": "It had already finished its work before the stop arrived; its result is delivered as usual.",
  terminated: "It ignored the stop and was killed. Its failed result still arrives with a respawn hint; do not respawn it unless the user asks.",
};

/**
 * Parent-model counterpart of the /agents stop. The runner enforces that only
 * runs this session started are addressable.
 */
export function registerSubagentStopTool(pi: ExtensionAPI, runner: SubagentRunner = subagentRunner): void {
  const tool: ToolDefinition<typeof SubagentStopToolParameters, undefined> = {
    name: "subagent_stop",
    label: "Stop subagent",
    description: DESCRIPTION,
    parameters: SubagentStopToolParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<undefined>> {
      try {
        assertSchemaValue(SubagentStopToolParameters, params, "subagent_stop input");
        const receipt = await runner.stopForParent(params.id.trim(), ctx.sessionManager.getSessionId());
        const note = NOTES[receipt.status];
        return {
          content: [{ type: "text", text: JSON.stringify(note ? { ...receipt, note } : receipt) }],
          details: undefined,
        };
      } catch (error) {
        throw new Error(errorMessage(error));
      }
    },
    renderCall(args, theme) {
      const target = typeof args?.id === "string" ? args.id : "run";
      return renderCallHeader(`stop · ${target}`, theme);
    },
    renderResult(result) {
      const textParts = (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
      const lines = textParts.length === 0 ? [] : sanitizeTerminalTextChunks(textParts, UNTRUSTED_FIELD_MAX, true).split("\n");
      return linesComponent((width) => lines.map((line) => truncateToWidth(line, width)), "subagent stop result");
    },
  };
  pi.registerTool(tool);
}
