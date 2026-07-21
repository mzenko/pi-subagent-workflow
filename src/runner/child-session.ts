import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { UsageSummary } from "../types.js";

/** Events consumed at the subprocess child-session seam. */
export type ChildSessionEvent =
  | { type: "tool_execution_start"; toolName: string; args: unknown }
  | { type: "turn_end"; message: AgentMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "agent_start" }
  | { type: "agent_settled" }
  | { type: string; [key: string]: unknown };

/**
 * The exact subprocess-child session surface the runner consumes. The RPC
 * adapter keeps process transport and containment outside the orchestration
 * layer while exposing only the child state the runner needs.
 */
export interface ChildSession {
  subscribe(listener: (event: ChildSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  /** Newest finalized assistant message, used for terminal result extraction. */
  readonly latestAssistant: AssistantMessage | undefined;
  /** Drop the retained message after the runner copies it into a terminal result. */
  clearLatestAssistant?(): void;
  /** Cumulative assistant usage folded at message arrival so totals remain
   * monotonic across pi-side transcript compaction. */
  readonly usage: UsageSummary;
  /** Child-written session file reported by the subprocess at startup. */
  readonly sessionFile: string | undefined;
  /** Asynchronous subprocess disposal: SIGTERM the group, escalate to a group
   * SIGKILL only while the leader is still alive at the grace deadline, then
   * await real exit. Group signals are never sent after the leader is reaped
   * (the numeric group id can be recycled), so a SIGTERM-ignoring descendant
   * that outlives a fast-exiting leader is an accepted bounded orphan. */
  dispose(): Promise<void>;
}
