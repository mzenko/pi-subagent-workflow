/**
 * ChildSession adapter for one `pi --mode rpc` subprocess. It translates the
 * runner lifecycle into RPC commands, folds bounded result and usage state,
 * and delegates process-group termination to the transport.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { UsageSummary } from "../../types.js";
import type { ChildSession, ChildSessionEvent } from "../child-session.js";
import type { ChildRpc } from "./rpc-transport.js";

/** SIGTERM-to-SIGKILL escalation window on dispose. */
const DISPOSE_KILL_GRACE_MS = 2_000;
/** Deadline on control-plane requests (get_state, steer); the turn itself is unbounded. */
const CONTROL_REQUEST_TIMEOUT_MS = 15_000;
/** Deadline on the prompt PREFLIGHT ack (not the turn): bounds a child wedged
 * before it even accepts the prompt, so it cannot hold the semaphore forever. */
const PROMPT_ACK_TIMEOUT_MS = 60_000;
/** How long a prompt with no agent run may stay unconfirmed before failing. */
const IMMEDIATE_COMPLETION_POLL_MS = 60;
const IMMEDIATE_COMPLETION_MAX_POLLS = 40;

interface RpcState {
  isStreaming?: boolean;
  isCompacting?: boolean;
  pendingMessageCount?: number;
  sessionFile?: unknown;
}

/**
 * The lifecycle of one prompt() call. Every way a turn can end goes through
 * exactly this object, so a stale poller or late event from a previous
 * prompt can never settle a later one.
 */
class PromptTurn {
  runStarted = false;
  done = false;
  readonly completion: Promise<void>;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: Error) => void;

  constructor() {
    this.completion = new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    // prompt() can throw (ack rejection) before it ever awaits completion;
    // fail() on this turn must then not surface as an unhandled rejection.
    // A caller's own await still receives the rejection normally.
    void this.completion.catch(() => undefined);
  }

  settle(): void {
    if (this.done) return;
    this.done = true;
    this.resolveCompletion();
  }

  fail(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.rejectCompletion(error);
  }
}

interface RpcChildSessionInit {
  /** The child-written session file, from get_state at startup. */
  sessionFile: string | undefined;
}

export class RpcChildSession implements ChildSession {
  /** Folding at message_end - not turn_end - means a process that dies
   * mid-turn still exposes its newest result and counts its billed usage. */
  latestAssistant: AssistantMessage | undefined;
  readonly usage: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
  readonly sessionFile: string | undefined;
  private turn: PromptTurn | undefined;
  private exitError: Error | undefined;

  constructor(private readonly rpc: ChildRpc, init: RpcChildSessionInit) {
    this.sessionFile = init.sessionFile;
    rpc.onEvent((event) => this.handleEvent(event));
    rpc.onExit((exit) => {
      this.exitError = new Error(`Child pi process exited before settling (code ${exit.code ?? "null"}, signal ${exit.signal ?? "null"}). Stderr: ${rpc.stderrTail() || "(empty)"}`);
      // A prompt awaiting its turn must fail, never hang, on child death.
      this.turn?.fail(this.exitError);
    });
  }

  /** Query child identity over the live channel and build the adapter. */
  static async start(rpc: ChildRpc): Promise<RpcChildSession> {
    const state = await rpc.request({ type: "get_state" }, { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS }) as RpcState | undefined;
    const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : undefined;
    return new RpcChildSession(rpc, { sessionFile });
  }

  subscribe(listener: (event: ChildSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    if (this.exitError) throw this.exitError;
    const turn = new PromptTurn();
    this.turn = turn;
    try {
      // The prompt response is the preflight ack, not turn completion; the turn
      // ends at agent_settled (unbounded - the runner's timeout/dispose bound it).
      // Only the ack is deadline-bounded, to catch a child wedged before accept.
      await this.rpc.request({ type: "prompt", message: text }, { timeoutMs: PROMPT_ACK_TIMEOUT_MS });
      // A prompt handled immediately (e.g. a slash command) never runs the
      // agent and never emits agent_settled; the poller settles or fails this
      // turn - and only this turn - for that case.
      void this.confirmImmediateCompletion(turn);
      await turn.completion;
    } finally {
      turn.done = true;
      if (this.turn === turn) this.turn = undefined;
    }
  }

  async steer(text: string): Promise<void> {
    await this.rpc.request({ type: "steer", message: text }, { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS });
  }

  async abort(): Promise<void> {
    if (this.exitError) return; // Aborting a dead child is complete by definition.
    await this.rpc.request({ type: "abort" }, { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS });
  }

  clearLatestAssistant(): void {
    this.latestAssistant = undefined;
  }

  /** SIGTERM the group, escalate to a group SIGKILL only while the leader is
   * still alive at the grace deadline, and await real exit. A descendant that
   * outlives a fast-exiting leader is a bounded orphan. */
  async dispose(): Promise<void> {
    this.rpc.kill("SIGTERM");
    const escalate = setTimeout(() => this.rpc.kill("SIGKILL"), DISPOSE_KILL_GRACE_MS);
    escalate.unref?.();
    try {
      await this.rpc.exited;
    } finally {
      clearTimeout(escalate);
    }
  }

  /**
   * Settle a turn whose prompt was handled WITHOUT an agent run (a slash
   * command or input handler): those never emit agent_settled, so waiting for
   * it would hold the semaphore slot forever. agent_start is the
   * discriminator - once it arrives on the (ordered) event stream this poller
   * stands down and only agent_settled or child death may end the turn.
   * Absent it, two consecutive positively-idle observations settle the turn;
   * a dead control channel or an exhausted budget FAILS the turn, because
   * silently giving up would strand the prompt (and its semaphore slot).
   */
  private async confirmImmediateCompletion(turn: PromptTurn): Promise<void> {
    let idleObservations = 0;
    for (let poll = 0; poll < IMMEDIATE_COMPLETION_MAX_POLLS; poll++) {
      await new Promise((resolve) => { const t = setTimeout(resolve, IMMEDIATE_COMPLETION_POLL_MS); t.unref?.(); });
      if (turn.done || turn.runStarted) return;
      let state: RpcState | undefined;
      try {
        state = await this.rpc.request({ type: "get_state" }, { timeoutMs: CONTROL_REQUEST_TIMEOUT_MS }) as RpcState;
      } catch (error) {
        // agent_start may have raced the failed read; a started turn is owned
        // by agent_settled/exit. Otherwise the control channel is gone or
        // wedged and the turn must fail rather than hang.
        if (!turn.runStarted && !turn.done) turn.fail(new Error(`Child state read failed while confirming prompt completion: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (turn.done || turn.runStarted) return;
      // Streaming is proof of a live run; stand down and let agent_settled or
      // child death end the turn.
      if (state?.isStreaming) return;
      if (state?.isCompacting) {
        idleObservations = 0;
        // Compaction is bounded pi-side work; the budget only guards
        // queued-never-started prompts.
        poll -= 1;
        continue;
      }
      if ((state?.pendingMessageCount ?? 0) > 0) {
        idleObservations = 0;
        continue;
      }
      idleObservations += 1;
      if (idleObservations >= 2) { turn.settle(); return; }
    }
    // Only reachable when the prompt stayed queued-but-never-started for the
    // whole budget: fail rather than strand the prompt and its semaphore slot.
    turn.fail(new Error(`Child neither started an agent run nor settled within ${IMMEDIATE_COMPLETION_MAX_POLLS} polls of the prompt ack`));
  }

  private handleEvent(event: Record<string, unknown>): void {
    if (event.type === "message_end") {
      const message = event.message as AgentMessage | undefined;
      if (message?.role === "assistant") {
        this.latestAssistant = message;
        this.usage.input += message.usage.input;
        this.usage.output += message.usage.output;
        this.usage.cacheRead += message.usage.cacheRead;
        this.usage.cacheWrite += message.usage.cacheWrite;
        this.usage.cost += message.usage.cost.total;
        this.usage.turns += 1;
      }
    }
    if (event.type === "agent_start" && this.turn) this.turn.runStarted = true;
    if (event.type === "agent_settled") this.turn?.settle();
    for (const listener of this.listeners) listener(event as ChildSessionEvent);
  }
}
