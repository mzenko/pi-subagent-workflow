/**
 * Minimal JSONL transport for a `pi --mode rpc` child process. Owns the
 * process: spawn, request/response correlation, event fan-out, and honest
 * exit semantics - every pending and future request rejects once the channel
 * is done, so a dead child can never leave a caller waiting.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { reportDiagnostic } from "../../diagnostics.js";
import { errorMessage } from "../../util.js";

export interface RpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RpcRequestOptions {
  /** Reject the request after this many ms if the child has not answered. */
  timeoutMs?: number;
}

/** The transport surface the session adapter consumes; faked in tests. */
export interface ChildRpc {
  request(command: Record<string, unknown>, options?: RpcRequestOptions): Promise<unknown>;
  /** Fire-and-forget write, for protocol messages with no response (extension_ui_response). */
  send(message: Record<string, unknown>): void;
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  /** Fires once; immediately when subscribing after exit. */
  onExit(listener: (exit: RpcExit) => void): () => void;
  kill(signal?: NodeJS.Signals): void;
  readonly exited: Promise<RpcExit>;
  /** Bounded tail of the child's stderr, for diagnostics. */
  stderrTail(): string;
}

const STDERR_TAIL_MAX = 4_096;
/** Largest JSONL frame buffered and parsed, in UTF-16 code units of decoded text. */
const MAX_LINE_CHARS = 8 * 1024 * 1024;
const MAX_DISCARDED_FRAME_CHARS = 512 * 1024 * 1024;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function spawnChildRpc(command: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): ChildRpc {
  const [binary, ...args] = command;
  if (!binary) throw new Error("Child RPC spawn requires a non-empty command");
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const pending = new Map<string, PendingRequest>();
  const eventListeners = new Set<(event: Record<string, unknown>) => void>();
  const exitListeners = new Set<(exit: RpcExit) => void>();
  let exitInfo: RpcExit | undefined;
  /** Set once the channel is settled (pending rejected, listeners fired). */
  let channelDone = false;
  let stderr = "";
  let requestId = 0;
  let stdoutBuffer = "";
  let discardedFrameChars: number | undefined;
  let stdoutDiscardFailed = false;
  // Decode across chunk boundaries so a multibyte UTF-8 sequence split between
  // two reads is not corrupted (plain chunk.toString would mangle it).
  const stdoutDecoder = new StringDecoder("utf8");

  let resolveExited: (exit: RpcExit) => void;
  const exited = new Promise<RpcExit>((resolve) => { resolveExited = resolve; });
  /** After 'exit', bound how long we wait for stdout 'close' before settling. */
  let settleGrace: ReturnType<typeof setTimeout> | undefined;
  const SETTLE_AFTER_EXIT_MS = 250;

  function killProcessGroup(signal: NodeJS.Signals): void {
    try {
      if (child.pid === undefined) throw new Error("child pid unavailable");
      process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  }

  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_MAX);
  });

  child.stdout.on("data", (chunk: Buffer) => {
    if (channelDone) return; // A settled channel buffers and dispatches nothing.
    drainStdoutLines(stdoutDecoder.write(chunk));
  });

  function drainStdoutLines(decoded = "", endOfStream = false): void {
    if (stdoutDiscardFailed) return;
    let offset = 0;
    while (offset < decoded.length) {
      if (discardedFrameChars !== undefined) {
        const newline = decoded.indexOf("\n", offset);
        const end = newline === -1 ? decoded.length : newline;
        discardedFrameChars += end - offset;
        if (failIfDiscardLimitExceeded()) return;
        if (newline === -1) break;
        reportDiscardedFrame(discardedFrameChars);
        discardedFrameChars = undefined;
        offset = newline + 1;
        continue;
      }

      const newline = decoded.indexOf("\n", offset);
      const end = newline === -1 ? decoded.length : newline;
      const segmentLength = end - offset;
      if (stdoutBuffer.length + segmentLength > MAX_LINE_CHARS) {
        discardedFrameChars = stdoutBuffer.length + segmentLength;
        stdoutBuffer = "";
        if (failIfDiscardLimitExceeded()) return;
        if (newline === -1) break;
        reportDiscardedFrame(discardedFrameChars);
        discardedFrameChars = undefined;
        offset = newline + 1;
        continue;
      }

      stdoutBuffer += decoded.slice(offset, end);
      if (newline === -1) break;
      const line = stdoutBuffer.trim();
      stdoutBuffer = "";
      if (line.length > 0) {
        let message: Record<string, unknown> | undefined;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          message = undefined; // Non-protocol stdout noise must not kill the channel.
        }
        if (message) handleMessage(message);
      }
      offset = newline + 1;
    }

    if (endOfStream && discardedFrameChars !== undefined) {
      reportDiscardedFrame(discardedFrameChars);
      discardedFrameChars = undefined;
    }
  }

  function failIfDiscardLimitExceeded(): boolean {
    if (discardedFrameChars === undefined || discardedFrameChars <= MAX_DISCARDED_FRAME_CHARS) return false;
    const total = discardedFrameChars;
    discardedFrameChars = undefined;
    stdoutDiscardFailed = true;
    failChannel(
      { code: null, signal: null },
      `Child RPC frame exceeded the ${MAX_LINE_CHARS}-character buffer cap and ${MAX_DISCARDED_FRAME_CHARS}-character hard discard limit; discarded ${total} characters without a newline; channel desynchronized`,
    );
    return true;
  }

  function reportDiscardedFrame(characters: number): void {
    // pi awaits stdout backpressure inside its agent loop, so every frame must
    // be drained. Only transcript-sized events can exceed this cap; response,
    // agent_start, agent_settled, and turn_end frames are bounded by model
    // output limits and remain safe.
    reportDiagnostic(`[subagent-workflow] discarded oversized child RPC frame of approximately ${characters} characters (buffer cap ${MAX_LINE_CHARS})`);
  }

  function handleMessage(message: Record<string, unknown>): void {
    if (message.type === "response" && typeof message.id === "string") {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (request.timer) clearTimeout(request.timer);
      if (message.success === true) request.resolve(message.data);
      else request.reject(new Error(typeof message.error === "string" ? message.error : `RPC ${String(message.command)} failed`));
      return;
    }
    if (typeof message.type === "string") {
      for (const listener of eventListeners) {
        try { listener(message); } catch (error) {
          reportDiagnostic(`[subagent-workflow] child event listener failed: ${errorMessage(error)}`);
        }
      }
    }
  }

  /** Settle the channel exactly once: reject pending, notify exit listeners. */
  function settleChannel(result: RpcExit, reason?: string): void {
    if (settleGrace) { clearTimeout(settleGrace); settleGrace = undefined; }
    if (channelDone) return;
    channelDone = true;
    exitInfo ??= result;
    const detail = reason ? `${reason}. ` : "";
    const failure = new Error(`${detail}Child pi channel closed (code ${exitInfo.code ?? "null"}, signal ${exitInfo.signal ?? "null"}). Stderr: ${stderr || "(empty)"}`);
    for (const request of pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(failure);
    }
    pending.clear();
    resolveExited(exitInfo);
    for (const listener of exitListeners) {
      try { listener(exitInfo); } catch (error) {
        reportDiagnostic(`[subagent-workflow] child exit listener failed: ${errorMessage(error)}`);
      }
    }
    exitListeners.clear();
  }

  /**
   * Force the channel down on a fatal I/O error. When a real process exists,
   * kill it and let the exit/close path settle, so `exited` never resolves
   * ahead of the OS process actually being gone; settle directly only when
   * there is no process to wait for (spawn failure).
   */
  function failChannel(result: RpcExit, reason: string): void {
    stderr = (stderr + `\n${reason}`).slice(-STDERR_TAIL_MAX);
    const processGone = exitInfo !== undefined || child.exitCode !== null || child.signalCode !== null;
    if (!processGone) killProcessGroup("SIGKILL");
    if (child.pid === undefined) {
      settleChannel(result, reason); // Never spawned; no exit event will come.
      return;
    }
    // exit -> bounded grace -> close settles the channel.
  }

  // Defer settlement (which resolves `exited` and rejects pending) to 'close',
  // after stdout fully ends, so a final buffered response still resolves its
  // request instead of being rejected as abandoned. But bound the wait: a
  // grandchild can keep the stdout pipe open past the child's own exit, so a
  // short grace after 'exit' forces settlement. `exited` thus resolves within
  // ~250ms of real exit, and by then the channel is fully settled - which is
  // what a dispose() awaiting it, and a late onExit subscriber, both rely on.
  child.on("exit", (code, signal) => {
    exitInfo ??= { code, signal };
    if (!channelDone && !settleGrace) {
      settleGrace = setTimeout(() => settleChannel(exitInfo ?? { code, signal }), SETTLE_AFTER_EXIT_MS);
      settleGrace.unref?.();
    }
  });
  child.on("close", (code, signal) => {
    drainStdoutLines(stdoutDecoder.end(), true);
    settleChannel(exitInfo ?? { code, signal });
  });
  child.on("error", (error) => failChannel({ code: null, signal: null }, `child spawn error: ${errorMessage(error)}`));
  // Unhandled stdin errors (EPIPE when the child closes its input while alive)
  // would otherwise crash the whole parent process.
  child.stdin.on("error", (error) => failChannel({ code: null, signal: null }, `child stdin error: ${errorMessage(error)}`));

  return {
    request(command: Record<string, unknown>, requestOptions?: RpcRequestOptions): Promise<unknown> {
      if (channelDone) return Promise.reject(new Error(`Child pi channel already closed (code ${exitInfo?.code ?? "null"}, signal ${exitInfo?.signal ?? "null"})`));
      const id = `req-${++requestId}`;
      return new Promise((resolve, reject) => {
        const entry: PendingRequest = { resolve, reject };
        if (requestOptions?.timeoutMs !== undefined) {
          entry.timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            reject(new Error(`Child RPC ${String(command.type)} timed out after ${requestOptions.timeoutMs}ms`));
          }, requestOptions.timeoutMs);
          entry.timer.unref?.();
        }
        pending.set(id, entry);
        child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
          if (!error) return;
          if (!pending.delete(id)) return;
          if (entry.timer) clearTimeout(entry.timer);
          reject(new Error(`Child RPC write failed: ${errorMessage(error)}`));
        });
      });
    },
    send(message: Record<string, unknown>): void {
      if (channelDone) return;
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reportDiagnostic(`[subagent-workflow] child RPC send failed: ${errorMessage(error)}`);
      });
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onExit(listener) {
      if (channelDone && exitInfo) {
        listener(exitInfo);
        return () => {};
      }
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    kill(signal: NodeJS.Signals = "SIGKILL") {
      if (!channelDone && child.exitCode === null && child.signalCode === null && child.pid !== undefined) killProcessGroup(signal);
    },
    exited,
    stderrTail: () => stderr,
  };
}
