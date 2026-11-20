import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { subagentRunner, type SubagentRunner } from "../runner/runner.js";
import { assertSchemaValue } from "../subagent-spec.js";
import { linesComponent } from "../ui/component.js";
import { sanitizeTerminalTextChunks, UNTRUSTED_FIELD_MAX } from "../ui/sanitize.js";
import { renderCallHeader } from "../ui/tool-render.js";
import { errorMessage } from "../util.js";

export const SubagentMessageToolParameters = Type.Object({
  id: Type.String({ minLength: 1, description: "The child id (or its runId) from the subagent tool's receipt." }),
  message: Type.String({ minLength: 1, description: "What the child should know or change. It arrives as a message from its parent agent." }),
}, { additionalProperties: false });
export type SubagentMessageToolInput = Static<typeof SubagentMessageToolParameters>;

const DESCRIPTION = "Send a message to a subagent you started that is still running: new information, a correction, or a change of direction. It is queued and reaches the child after its current tool calls finish; a child still waiting to start gets it right after its task prompt. The child does not reply - its reaction shows up in its final result, which still arrives as usual, so do not wait or poll. A message that lands as the child is finishing may never be read; the result then lists it as unconfirmed. Finished children cannot be messaged - use subagent followUp. Workflow children cannot be messaged.";

/**
 * Parent-model counterpart of /agents steering. Only children this session
 * spawned with the subagent tool are addressable; the runner enforces that, so
 * ids discovered on disk (workflow children, other sessions) are refused.
 */
export function registerSubagentMessageTool(pi: ExtensionAPI, runner: SubagentRunner = subagentRunner): void {
  const tool: ToolDefinition<typeof SubagentMessageToolParameters, undefined> = {
    name: "subagent_message",
    label: "Subagent message",
    description: DESCRIPTION,
    parameters: SubagentMessageToolParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<undefined>> {
      try {
        assertSchemaValue(SubagentMessageToolParameters, params, "subagent_message input");
        // Trim only to reject blank input; the text is forwarded as written so
        // indentation in code fragments survives.
        if (!params.message.trim()) throw new Error("Message must not be empty");
        const receipt = await runner.messageChild(params.id.trim(), ctx.sessionManager.getSessionId(), params.message);
        const note = receipt.delivery === "buffered"
          ? "The child has not started yet; it reads the message right after its task prompt."
          : "Queued; the child reads it after its current tool calls finish.";
        return {
          content: [{ type: "text", text: JSON.stringify({ id: receipt.childId, messageId: receipt.messageId, status: receipt.delivery, note }) }],
          details: undefined,
        };
      } catch (error) {
        throw new Error(errorMessage(error));
      }
    },
    renderCall(args, theme) {
      const target = typeof args?.id === "string" ? args.id : "subagent";
      return renderCallHeader(`message · ${target}`, theme);
    },
    renderResult(result) {
      const textParts = (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
      const lines = textParts.length === 0 ? [] : sanitizeTerminalTextChunks(textParts, UNTRUSTED_FIELD_MAX, true).split("\n");
      return linesComponent((width) => lines.map((line) => truncateToWidth(line, width)), "subagent message result");
    },
  };
  pi.registerTool(tool);
}
