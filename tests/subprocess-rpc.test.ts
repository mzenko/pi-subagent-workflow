import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ChildSessionEvent } from "../src/runner/child-session.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildArgs } from "../src/runner/subprocess/child-args.js";
import { RpcChildSession } from "../src/runner/subprocess/rpc-child-session.js";
import {
  RPC_MAX_FRAME_CHARS,
  RpcChannelClosedError,
  RpcCommandRejectedError,
  RpcFrameTooLargeError,
  RpcProtocolError,
  spawnChildRpc,
  type ChildRpc,
  type RpcExit,
} from "../src/runner/subprocess/rpc-transport.js";

describe("buildChildArgs", () => {
  const base = {
    provider: "openai-codex",
    modelId: "gpt-5.6-terra",
    thinkingLevel: "high" as const,
    sessionDir: "/runs/r1/sessions",
    appendSystemPrompt: "You are a subagent.",
  };

  test("maps every construction-time injection to a flag", () => {
    const args = buildChildArgs({ ...base, tools: ["read", "bash"], shimPath: "/pkg/dist/child-shim.js" });
    expect(args).toEqual([
      "--mode", "rpc",
      "--provider", "openai-codex",
      "--model", "gpt-5.6-terra",
      "--thinking", "high",
      "--session-dir", "/runs/r1/sessions",
      "--append-system-prompt", "You are a subagent.",
      "--exclude-tools", "subagent,workflow",
      "--tools", "read,bash",
      "--extension", "/pkg/dist/child-shim.js",
    ]);
  });

  test("always excludes the recursion-guard tools, merged with requested exclusions", () => {
    const args = buildChildArgs({ ...base, excludeTools: ["todo", "subagent"] });
    const excludeIndex = args.indexOf("--exclude-tools");
    expect(args[excludeIndex + 1]).toBe("todo,subagent,workflow");
    expect(args).not.toContain("--tools");
  });

  test("maps a persisted session file to the fork flag", () => {
    const args = buildChildArgs({ ...base, forkSessionFile: "/runs/source/sessions/original.jsonl" });
    const forkIndex = args.indexOf("--fork");
    expect(forkIndex).toBeGreaterThan(-1);
    expect(args[forkIndex + 1]).toBe("/runs/source/sessions/original.jsonl");
  });

  test("an explicit empty allowlist crosses as --tools '' (zero tools), not as no flag", () => {
    const args = buildChildArgs({ ...base, tools: [] });
    const toolsIndex = args.indexOf("--tools");
    expect(toolsIndex).toBeGreaterThan(-1);
    expect(args[toolsIndex + 1]).toBe("");
  });

  test("rejects tool names a comma-splitting CLI boundary would corrupt", () => {
    expect(() => buildChildArgs({ ...base, tools: ["read,write"] })).toThrow(/comma/);
    expect(() => buildChildArgs({ ...base, excludeTools: ["a,b"] })).toThrow(/comma/);
  });
});

/** Scripted in-memory transport standing in for a child pi process. */
function fakeRpc(): ChildRpc & {
  sent: Array<Record<string, unknown>>;
  emit: (event: Record<string, unknown>) => void;
  exit: (exit: RpcExit) => void;
  killed: NodeJS.Signals[];
  respond: (command: string, data?: unknown) => void;
} {
  const eventListeners = new Set<(event: Record<string, unknown>) => void>();
  const exitListeners = new Set<(exit: RpcExit) => void>();
  const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; command: string }>();
  let exited: RpcExit | undefined;
  let resolveExited: (exit: RpcExit) => void;
  const exitedPromise = new Promise<RpcExit>((resolve) => { resolveExited = resolve; });
  let id = 0;
  const sent: Array<Record<string, unknown>> = [];
  const responders = new Map<string, unknown>();
  return {
    sent,
    killed: [],
    respond(command, data) { responders.set(command, data); },
    send(message) { sent.push(message); },
    request(command, options) {
      if (exited) return Promise.reject(new Error("already exited"));
      sent.push(command);
      const type = command.type as string;
      if (responders.has(type)) {
        const scripted = responders.get(type);
        const response = typeof scripted === "function" ? (scripted as () => unknown)() : scripted;
        if (response instanceof Error) return Promise.reject(response);
        options?.onResponse?.(response);
        return Promise.resolve(response);
      }
      return new Promise((resolve, reject) => { pending.set(`r${++id}`, { resolve, reject, command: type }); });
    },
    onEvent(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    onExit(listener) {
      if (exited) { listener(exited); return () => {}; }
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    kill(signal = "SIGKILL") { this.killed.push(signal); },
    exited: exitedPromise,
    stderrTail: () => "boom",
    emit(event) { for (const listener of eventListeners) listener(event); },
    exit(exit) {
      exited = exit;
      resolveExited(exit);
      const failure = new Error("child exited");
      for (const request of pending.values()) request.reject(failure);
      pending.clear();
      for (const listener of exitListeners) listener(exit);
      exitListeners.clear();
    },
  };
}

const assistant = (text: string, input = 0, output = 0): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  usage: { input, output, cacheRead: 1, cacheWrite: 2, cost: { total: 0.01 } },
  stopReason: "stop",
} as unknown as AssistantMessage);

describe("RpcChildSession", () => {
  test("start captures the child session file from get_state", async () => {
    const rpc = fakeRpc();
    rpc.respond("get_state", { isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionFile: "/sessions/child.jsonl" });
    const session = await RpcChildSession.start(rpc);
    expect(session.sessionFile).toBe("/sessions/child.jsonl");
  });

  test("startup lifecycle frames cannot contaminate the first prompt", async () => {
    const rpc = fakeRpc();
    const stale = assistant("stale", 7, 9);
    rpc.respond("get_state", () => {
      rpc.emit({ type: "message_start", message: stale });
      rpc.emit({ type: "message_end", message: stale });
      rpc.emit({ type: "agent_settled" });
      return { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
    });
    const session = await RpcChildSession.start(rpc);

    expect(session.currentAssistant).toBeUndefined();
    expect(session.latestAssistant).toBeUndefined();
    expect(session.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });

    rpc.respond("prompt", undefined);
    rpc.respond("get_state", { isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    await session.prompt("first prompt");
    expect(session.latestAssistant).toBeUndefined();
  });

  test("prompt sends the message and resolves on agent_settled", async () => {
    const rpc = fakeRpc();
    rpc.respond("prompt", undefined);
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    let resolved = false;
    const turn = session.prompt("do the task").then(() => { resolved = true; });
    await Bun.sleep(0);
    expect(rpc.sent).toEqual([{ type: "prompt", message: "do the task" }]);
    expect(resolved).toBe(false);
    // Settlement without this prompt's own run evidence must not complete it.
    rpc.emit({ type: "agent_settled" });
    await Bun.sleep(0);
    expect(resolved).toBe(false);
    rpc.emit({ type: "agent_start" });
    rpc.emit({ type: "agent_settled" });
    await turn;
    expect(resolved).toBe(true);
  });

  test("a stale settlement cannot complete the next sequential prompt", async () => {
    const rpc = fakeRpc();
    rpc.respond("prompt", undefined);
    const session = new RpcChildSession(rpc, { sessionFile: undefined });

    const first = session.prompt("first");
    await Bun.sleep(0);
    rpc.emit({ type: "agent_start" });
    rpc.emit({ type: "agent_settled" });
    await first;

    let secondResolved = false;
    const second = session.prompt("second").then(() => { secondResolved = true; });
    await Bun.sleep(0);
    rpc.emit({ type: "agent_settled" });
    await Bun.sleep(0);
    expect(secondResolved).toBe(false);

    rpc.emit({ type: "agent_start" });
    rpc.emit({ type: "agent_settled" });
    await second;
    expect(secondResolved).toBe(true);
  });

  test("custom message lifecycle events do not let a stale settlement complete a pending prompt", async () => {
    const rpc = fakeRpc();
    rpc.respond("get_state", { isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    const session = await RpcChildSession.start(rpc);
    rpc.respond("prompt", undefined);
    let resolved = false;
    const turn = session.prompt("pending prompt").then(() => { resolved = true; });
    await Bun.sleep(0);

    const custom = { role: "custom", customType: "notice", content: "outside an agent run" };
    rpc.emit({ type: "message_start", message: custom });
    rpc.emit({ type: "message_update", message: custom, assistantMessageEvent: { type: "citation_delta" } });
    rpc.emit({ type: "message_end", message: custom });
    rpc.emit({ type: "agent_settled" });
    await Bun.sleep(0);
    expect(resolved).toBe(false);

    rpc.emit({ type: "agent_start" });
    rpc.emit({ type: "agent_settled" });
    await turn;
    expect(resolved).toBe(true);
  });

  test("run activity accepts guarded prompts without agent_start", async () => {
    const rpc = fakeRpc();
    // Idle only for the startup handshake; every later get_state reports
    // compacting so the idle poller can neither settle the turn nor mark it
    // accepted. Settlement can then come only from the emitted run activity, so
    // a fixture that is not real run evidence hangs the turn and fails the test.
    let startupStateRead = false;
    rpc.respond("get_state", () => {
      if (!startupStateRead) {
        startupStateRead = true;
        return { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
      }
      return { isStreaming: false, isCompacting: true, pendingMessageCount: 0 };
    });
    rpc.respond("prompt", undefined);
    const session = await RpcChildSession.start(rpc);
    const activities = [
      { type: "message_start", message: { role: "user", content: [] } },
      { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "citation_delta" } },
      { type: "message_end", message: { role: "user", content: [] } },
      { type: "turn_end", message: { role: "user", content: [] } },
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} },
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: {}, isError: false },
    ];

    for (const activity of activities) {
      const turn = session.prompt("do the task");
      await Bun.sleep(0);
      rpc.emit(activity);
      rpc.emit({ type: "agent_settled" });
      await expect(turn).resolves.toBeUndefined();
    }
  });

  test("a non-conversation-role message does not accept a guarded prompt", async () => {
    const rpc = fakeRpc();
    let startupStateRead = false;
    rpc.respond("get_state", () => {
      if (!startupStateRead) {
        startupStateRead = true;
        return { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
      }
      return { isStreaming: false, isCompacting: true, pendingMessageCount: 0 };
    });
    rpc.respond("prompt", undefined);
    const session = await RpcChildSession.start(rpc);
    const turn = session.prompt("do the task");
    await Bun.sleep(0);
    // A custom-role message emitted outside an agent run is not run evidence, so
    // a stale agent_settled must not settle the pending turn.
    const custom = { role: "custom", content: "outside a run" };
    rpc.emit({ type: "message_start", message: custom });
    rpc.emit({ type: "message_end", message: custom });
    rpc.emit({ type: "agent_settled" });
    let settled = false;
    void turn.then(() => { settled = true; });
    await Bun.sleep(0);
    expect(settled).toBe(false);

    rpc.emit({ type: "agent_start" });
    rpc.emit({ type: "agent_settled" });
    await expect(turn).resolves.toBeUndefined();
  });

  test("prompt rejects instead of hanging when the child dies mid-turn", async () => {
    const rpc = fakeRpc();
    rpc.respond("prompt", undefined);
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    const turn = session.prompt("do the task");
    await Bun.sleep(0);
    rpc.exit({ code: 1, signal: null });
    await expect(turn).rejects.toThrow(/exited before settling.*code 1.*boom/s);
  });

  test("child death during a pending prompt ack raises no unhandled rejection", async () => {
    const rpc = fakeRpc(); // "prompt" unscripted: the ack stays pending
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const turn = session.prompt("do the task");
      await Bun.sleep(0);
      // Exit rejects the pending ack first, then fails the turn; prompt()
      // exits via the ack rejection without ever awaiting the turn.
      rpc.exit({ code: 1, signal: null });
      await expect(turn).rejects.toThrow();
      await Bun.sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a dead control channel fails a prompt that never started a run", async () => {
    const rpc = fakeRpc();
    rpc.respond("prompt", undefined);
    rpc.respond("get_state", new Error("wedged"));
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    await expect(session.prompt("maybe-a-command")).rejects.toThrow(/state read failed/);
  });

  test("a prompt that stays queued without ever starting a run fails instead of hanging", async () => {
    const rpc = fakeRpc();
    rpc.respond("prompt", undefined);
    rpc.respond("get_state", { isStreaming: false, isCompacting: false, pendingMessageCount: 1 });
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    await expect(session.prompt("stuck")).rejects.toThrow(/neither started an agent run nor settled/);
  }, 20_000);

  test("transient compaction does not stand down or exhaust the immediate-completion poller", async () => {
    const rpc = fakeRpc();
    rpc.respond("prompt", undefined);
    let polls = 0;
    rpc.respond("get_state", () => {
      polls += 1;
      return polls <= 3
        ? { isStreaming: false, isCompacting: true, pendingMessageCount: 0 }
        : { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
    });
    const session = new RpcChildSession(rpc, { sessionFile: undefined });

    await expect(session.prompt("/compact")).resolves.toBeUndefined();
    expect(polls).toBe(5);
  });

  test("prompt after child exit fails immediately", async () => {
    const rpc = fakeRpc();
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    rpc.exit({ code: null, signal: "SIGKILL" });
    await expect(session.prompt("late")).rejects.toThrow(/exited before settling/);
  });

  test("keeps only the latest assistant and accumulates usage at message_end", () => {
    const rpc = fakeRpc();
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    rpc.emit({ type: "message_end", message: assistant("first", 3, 4) });
    rpc.emit({ type: "message_end", message: { role: "user", content: [] } });
    rpc.emit({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "large output" }] } });
    rpc.emit({ type: "message_end", message: assistant("billed-but-turn-never-ended", 5, 6) });

    expect(session.latestAssistant).toEqual(assistant("billed-but-turn-never-ended", 5, 6));
    expect(session.usage).toEqual({ input: 8, output: 10, cacheRead: 2, cacheWrite: 4, cost: 0.02, turns: 2 });
    expect("messages" in session).toBe(false);
  });

  test("forwards streaming events and clears currentAssistant only at settlement", () => {
    const rpc = fakeRpc();
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    const partial = assistant("partial");
    const updated = assistant("updated");
    const final = assistant("final");
    const update = {
      type: "text_delta",
      contentIndex: 0,
      delta: "updated",
      partial: updated,
    } satisfies AssistantMessageEvent;
    const seen: Array<{ event: ChildSessionEvent; current: AssistantMessage | undefined }> = [];
    session.subscribe((event) => seen.push({ event, current: session.currentAssistant }));

    rpc.emit({ type: "message_start", message: partial });
    rpc.emit({ type: "message_update", message: updated, assistantMessageEvent: update });
    rpc.emit({ type: "message_end", message: final });

    expect(session.currentAssistant).toEqual(final);
    expect(seen.map(({ event }) => event.type)).toEqual(["message_start", "message_update", "message_end"]);
    expect(seen.map(({ current }) => current)).toEqual([partial, updated, final]);

    // A tool-result lifecycle between assistant steps must not drop the
    // retained assistant: only settlement hands rendering back to the file.
    rpc.emit({ type: "message_start", message: { role: "toolResult", content: [] } });
    rpc.emit({ type: "message_end", message: { role: "toolResult", content: [] } });
    expect(session.currentAssistant).toEqual(final);

    rpc.emit({ type: "agent_settled" });
    expect(session.currentAssistant).toBeUndefined();
    expect(seen.at(-1)).toEqual({ event: { type: "agent_settled" }, current: undefined });
  });

  test("forwards unknown assistant update variants opaquely and ignores unknown event types", () => {
    const rpc = fakeRpc();
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    const seen: ChildSessionEvent[] = [];
    session.subscribe((event) => seen.push(event));

    rpc.emit({ type: "message_update", message: assistant("citation"), assistantMessageEvent: { type: "citation_delta", citation: "x" } });
    rpc.emit({ type: "installed_custom_event", payload: true });

    expect(seen).toEqual([{ type: "message_update", opaqueAssistantMessageUpdate: { opaqueType: "citation_delta" } }]);
    expect(session.currentAssistant).toBeUndefined();
  });

  test("forwards events to subscribers until unsubscribed", () => {
    const rpc = fakeRpc();
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    const seen: string[] = [];
    const unsubscribe = session.subscribe((event) => seen.push((event as { type: string }).type));
    rpc.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
    unsubscribe();
    rpc.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "ok", isError: false });
    expect(seen).toEqual(["tool_execution_start"]);
  });

  test("steer and abort travel the command channel; abort on a dead child is a no-op", async () => {
    const rpc = fakeRpc();
    rpc.respond("steer", undefined);
    rpc.respond("abort", undefined);
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    await session.steer("adjust course");
    await session.abort();
    expect(rpc.sent).toEqual([{ type: "steer", message: "adjust course" }, { type: "abort" }]);
    rpc.exit({ code: 0, signal: null });
    await session.abort();
    expect(rpc.sent).toHaveLength(2);
  });

  test("dispose sends SIGTERM and resolves only once the process has exited", async () => {
    const rpc = fakeRpc();
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    let resolved = false;
    const disposal = Promise.resolve(session.dispose()).then(() => { resolved = true; });
    const duplicate = session.dispose();
    await Bun.sleep(10);
    expect(rpc.killed).toEqual(["SIGTERM"]);
    expect(resolved).toBe(false);
    rpc.exit({ code: null, signal: "SIGTERM" });
    await Promise.all([disposal, duplicate]);
    expect(resolved).toBe(true);
    expect(rpc.killed).toEqual(["SIGTERM"]);
  });

  test("a prompt handled without an agent run settles from idle state, a real run does not", async () => {
    const idle = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
    const immediate = fakeRpc();
    immediate.respond("prompt", undefined);
    immediate.respond("get_state", idle);
    const handled = new RpcChildSession(immediate, { sessionFile: undefined });
    // No agent_settled will ever arrive; two idle observations settle it.
    await handled.prompt("/some-command");

    const running = fakeRpc();
    running.respond("prompt", undefined);
    running.respond("get_state", idle);
    const session = new RpcChildSession(running, { sessionFile: undefined });
    let resolved = false;
    const turn = session.prompt("do real work").then(() => { resolved = true; });
    running.emit({ type: "agent_start" });
    // agent_start stands the idle poller down even though get_state reads idle.
    await Bun.sleep(300);
    expect(resolved).toBe(false);
    running.emit({ type: "agent_settled" });
    await turn;
    expect(resolved).toBe(true);
  });
});

describe("spawnChildRpc transport", () => {
  // Bun 1.3 does not deliver piped stdin to detached test children, so this
  // protocol fixture emits responses for the transport's deterministic ids.
  // Production pi children run under Node and read the request pipe normally.
  const childScript = `
    console.log(JSON.stringify({ type: "hello_event" }));
    setTimeout(() => console.log(JSON.stringify({ type: "response", id: "req-1", command: "get_state", success: true, data: { sessionFile: "/tmp/x.jsonl" } })), 25);
    setTimeout(() => console.log(JSON.stringify({ type: "response", id: "req-2", command: "explode", success: false, error: "no such command" })), 50);
    setInterval(() => {}, 1000);
  `;
  // Every spawned child is killed and reaped after its test, even when an
  // assertion throws mid-test: a leaked child wedges the whole suite.
  const liveRpcs: ReturnType<typeof spawnChildRpc>[] = [];
  const tracked = (rpc: ReturnType<typeof spawnChildRpc>): ReturnType<typeof spawnChildRpc> => {
    liveRpcs.push(rpc);
    return rpc;
  };
  afterEach(async () => {
    for (const rpc of liveRpcs.splice(0)) {
      rpc.kill("SIGKILL");
      await rpc.exited;
    }
  });
  const spawnFake = () => tracked(spawnChildRpc([process.execPath, "-e", childScript], { cwd: process.cwd() }));

  test("settles when streaming state and agent_settled share one stdout write", async () => {
    const idle = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
    const running = { isStreaming: true, isCompacting: false, pendingMessageCount: 0 };
    const script = `
      setTimeout(() => process.stdout.write(JSON.stringify({ type: "response", id: "req-1", command: "get_state", success: true, data: ${JSON.stringify(idle)} }) + "\\n"), 20);
      setTimeout(() => process.stdout.write(JSON.stringify({ type: "response", id: "req-2", command: "prompt", success: true }) + "\\n"), 50);
      setTimeout(() => process.stdout.write([
        { type: "response", id: "req-3", command: "get_state", success: true, data: ${JSON.stringify(running)} },
        { type: "agent_settled" },
      ].map(JSON.stringify).join("\\n") + "\\n"), 150);
      setInterval(() => {}, 1000);
    `;
    const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
    const session = await RpcChildSession.start(rpc);

    await expect(Promise.race([
      session.prompt("do the task"),
      Bun.sleep(1_000).then(() => { throw new Error("prompt did not settle"); }),
    ])).resolves.toBeUndefined();
  });

  test("correlates responses, fans out events, and reports failure responses", async () => {
    const rpc = spawnFake();
    const events: string[] = [];
    rpc.onEvent((event) => events.push(event.type as string));
    const state = await rpc.request({ type: "get_state" }) as { sessionFile: string };
    expect(state.sessionFile).toBe("/tmp/x.jsonl");
    await expect(rpc.request({ type: "explode" })).rejects.toBeInstanceOf(RpcCommandRejectedError);
    expect(events).toContain("hello_event");
  });

  for (const [malformation, response] of [
    ["wrong command echo", { command: "steer", success: false, error: "wrong command" }],
    ["missing boolean success", { command: "prompt" }],
  ] as const) {
    test(`a correlated response with ${malformation} terminally fails the channel`, async () => {
      const script = `
        const frames = [
          { type: "response", id: "req-1", ...${JSON.stringify(response)} },
          { type: "response", id: "req-2", command: "steer", success: true, data: "too late" },
          { type: "event_after_fault" },
        ];
        setTimeout(() => process.stdout.write(frames.map(JSON.stringify).join("\\n") + "\\n"), 20);
        setInterval(() => {}, 1000);
      `;
      const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
      const events: string[] = [];
      rpc.onEvent((event) => events.push(String(event.type)));
      const offending = rpc.request({ type: "prompt" });
      const concurrent = rpc.request({ type: "steer" });
      const [offendingError, concurrentError] = await Promise.all([
        offending.then(() => undefined, (error: unknown) => error),
        concurrent.then(() => undefined, (error: unknown) => error),
      ]);

      expect(offendingError).toBeInstanceOf(RpcProtocolError);
      expect(offendingError).not.toBeInstanceOf(RpcCommandRejectedError);
      expect(concurrentError).toBe(offendingError);
      const laterError = await rpc.request({ type: "later" }).then(() => undefined, (error: unknown) => error);
      expect(laterError).toBe(offendingError);
      expect(events).toEqual([]);
      expect((await rpc.exited).signal).toBe("SIGKILL");
    });
  }

  test("rejects in-flight and later requests when the child exits, with stderr context", async () => {
    const script = `
      console.log(JSON.stringify({ type: "response", id: "req-1", command: "get_state", success: true, data: { sessionFile: "/tmp/x.jsonl" } }));
      setTimeout(() => { process.stderr.write("dying now"); process.exit(3); }, 100);
    `;
    const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
    await rpc.request({ type: "get_state" });
    const deadError = await rpc.request({ type: "die" }).then(() => undefined, (error: unknown) => error);
    expect(deadError).toEqual(expect.objectContaining({ message: expect.stringMatching(/code 3.*dying now/s) }));
    const exit = await rpc.exited;
    expect(exit.code).toBe(3);
    const laterError = await rpc.request({ type: "get_state" }).then(() => undefined, (error: unknown) => error);
    expect(laterError).toBe(deadError);
  });

  test("request write failure rejects pending and future requests before late responses arrive", async () => {
    const grandchildScript = [
      "const frames = [",
      "  { type: 'response', id: 'req-1', command: 'pending', success: true, data: 'too late' },",
      "  { type: 'response', id: 'req-3', command: 'later', success: true, data: 'also too late' },",
      "  { type: 'event_after_fault' },",
      "];",
      "setTimeout(() => process.stdout.write(frames.map(JSON.stringify).join('\\n') + '\\n', () => process.exit(0)), 100);",
    ].join(String.fromCharCode(10));
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { closeSync } = require('node:fs');",
      "const readline = require('node:readline');",
      "process.stdin.on('error', () => {});",
      "const input = readline.createInterface({ input: process.stdin });",
      "input.once('line', () => {",
      "  input.close();",
      "  closeSync(0);",
      `  spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref();`,
      "  console.log(JSON.stringify({ type: 'stdin_closed' }));",
      "});",
      "setInterval(() => {}, 1000);",
    ].join(String.fromCharCode(10));
    const rpc = tracked(spawnChildRpc(["node", "-e", script], { cwd: process.cwd() }));
    const events: string[] = [];
    const stdinClosed = new Promise<void>((resolve) => {
      rpc.onEvent((event) => {
        events.push(String(event.type));
        if (event.type === "stdin_closed") resolve();
      });
    });
    const pending = rpc.request({ type: "pending" });
    await stdinClosed;

    const payload = "x".repeat(1024 * 1024);
    const faulting = rpc.request({ type: "faulting", payload });
    const faultingOutcome = faulting.then((value) => value, (error: unknown) => error);
    const pendingOutcome = pending.then((value) => value, (error: unknown) => error);
    const writeFailureDeadline = Date.now() + 1_000;
    while (!rpc.stderrTail().includes("request write failed") && Date.now() < writeFailureDeadline) await Bun.sleep(5);
    expect(rpc.stderrTail()).toContain("request write failed");
    const later = rpc.request({ type: "later" });
    const [failure, pendingError, laterError] = await Promise.all([
      faultingOutcome,
      pendingOutcome,
      later.then((value) => value, (error: unknown) => error),
    ]);

    expect(failure).toBeInstanceOf(RpcChannelClosedError);
    expect(failure).toEqual(expect.objectContaining({ message: expect.stringContaining("request write failed") }));
    expect(pendingError).toBe(failure);
    expect(laterError).toBe(failure);
    expect((await rpc.exited).signal).toBe("SIGKILL");
    expect(events).toEqual(["stdin_closed"]);
  });

  test("fire-and-forget send write failure fatally closes and reaps the channel", async () => {
    const script = [
      "require('node:fs').closeSync(0);",
      "console.log(JSON.stringify({ type: 'stdin_closed' }));",
      "setInterval(() => {}, 1000);",
    ].join(String.fromCharCode(10));
    const rpc = tracked(spawnChildRpc(["node", "-e", script], { cwd: process.cwd() }));
    await new Promise<void>((resolve) => {
      const unsubscribe = rpc.onEvent((event) => {
        if (event.type !== "stdin_closed") return;
        unsubscribe();
        resolve();
      });
    });

    rpc.send({ type: "extension_ui_response", id: "ui", cancelled: true, payload: "x".repeat(1024 * 1024) });
    expect((await rpc.exited).signal).toBe("SIGKILL");
    const firstLaterError = await rpc.request({ type: "later-1" }).then(() => undefined, (error: unknown) => error);
    const secondLaterError = await rpc.request({ type: "later-2" }).then(() => undefined, (error: unknown) => error);
    expect(firstLaterError).toBeInstanceOf(RpcChannelClosedError);
    expect(firstLaterError).toEqual(expect.objectContaining({ message: expect.stringContaining("send write failed") }));
    expect(secondLaterError).toBe(firstLaterError);
  });

  test("a child that closes stdin while alive cannot crash the parent, and requests still settle", async () => {
    // Production pi runs under node, where the unhandled stdin 'error'
    // (EPIPE) terminated the whole parent process before the transport
    // registered its handler. bun swallows that error, so this test asserts
    // the observable contract on both runtimes: the parent survives and a
    // request against the dead input settles (deadline or channel failure)
    // instead of hanging.
    const script = "process.stdin.destroy(); setInterval(() => {}, 1000);";
    const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
    await Bun.sleep(100);
    await expect(rpc.request({ type: "get_state" }, { timeoutMs: 400 })).rejects.toThrow(/timed out|closed|stdin/);
  });

  test("decodes multibyte UTF-8 split across chunk boundaries", async () => {
    // The child assembles the frame from raw bytes and flushes it in two
    // writes split INSIDE the 2-byte sequence 0xC3 0xA9 (e-acute).
    const script = [
      "const head = Buffer.from(JSON.stringify({ type: 'emoji_event', text: 'caf' }).slice(0, -2));",
      "const frame = Buffer.concat([head, Buffer.from([0xc3, 0xa9]), Buffer.from([0x22, 0x7d, 0x0a])]);",
      "const mid = frame.length - 4;",
      "process.stdout.write(frame.subarray(0, mid));",
      "setTimeout(() => { process.stdout.write(frame.subarray(mid)); }, 50);",
      "setTimeout(() => process.exit(0), 200);",
    ].join(String.fromCharCode(10));
    const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
    const events: Array<Record<string, unknown>> = [];
    rpc.onEvent((event) => events.push(event));
    await rpc.exited;
    await Bun.sleep(300); // allow close-drain settlement
    const emoji = events.find((event) => event.type === "emoji_event");
    expect(emoji?.text).toBe("caf" + String.fromCharCode(0xe9));
  });

  test("accepts an exact-limit escaped message_update frame with duplicated snapshots", async () => {
    const script = [
      "const { once } = require('node:events');",
      "const readline = require('node:readline');",
      `const cap = ${RPC_MAX_FRAME_CHARS};`,
      "const heavy = String.fromCharCode(34, 92, 0, 10, 9, 13).repeat(200000);",
      "const snapshot = { role: 'assistant', content: [{ type: 'text', text: heavy }], api: 'test', provider: 'test', model: 'tiny', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 1 };",
      "const event = { type: 'message_update', message: snapshot, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: heavy.slice(0, 6), partial: snapshot }, padding: '' };",
      "const base = JSON.stringify(event);",
      "event.padding = 'x'.repeat(cap - base.length);",
      "const frame = JSON.stringify(event);",
      "if (frame.length !== cap) throw new Error('frame sizing failed: ' + frame.length);",
      "const write = async (text) => { if (!process.stdout.write(text)) await once(process.stdout, 'drain'); };",
      "void write(frame + '\\n');",
      "readline.createInterface({ input: process.stdin }).on('line', (line) => { const request = JSON.parse(line); void write(JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data: { ready: true } }) + '\\n'); });",
      "setInterval(() => {}, 1000);",
    ].join(String.fromCharCode(10));
    const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
    const events: Array<Record<string, unknown>> = [];
    rpc.onEvent((event) => events.push(event));

    await expect(rpc.request({ type: "get_state" })).resolves.toEqual({ ready: true });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("message_update");
    expect((events[0]?.assistantMessageEvent as { partial?: unknown })?.partial).toEqual(events[0]?.message);
  }, 30_000);

  test("discards an oversized entry_appended event as the first frame and continues normally", async () => {
    const script = [
      "const { once } = require('node:events');",
      "const write = async (text) => { if (!process.stdout.write(text)) await once(process.stdout, 'drain'); };",
      "void (async () => {",
      "  await write('{\"type\":\"entry_appended\",\"entry\":{\"type\":\"custom\",\"customType\":\"web-search-results\",\"data\":\"');",
      "  const chunk = 'x'.repeat(256 * 1024);",
      "  for (let index = 0; index < 33; index += 1) await write(chunk);",
      "  await write(Buffer.from([0xc3]));",
      "  await new Promise((resolve) => setTimeout(resolve, 20));",
      "  await write(Buffer.concat([Buffer.from([0xa9]), Buffer.from('\"}}\\n' + JSON.stringify({ type: 'small_event' }) + '\\n' + JSON.stringify({ type: 'response', id: 'req-1', command: 'get_state', success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } }) + '\\n')]));",
      "  setTimeout(() => void write(JSON.stringify({ type: 'response', id: 'req-2', command: 'second', success: true, data: 'still-working' }) + '\\n'), 100);",
      "})();",
      "setInterval(() => {}, 1000);",
    ].join(String.fromCharCode(10));
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
      const events: string[] = [];
      rpc.onEvent((event) => events.push(String(event.type)));

      await RpcChildSession.start(rpc);
      expect(events).toEqual(["small_event"]);
      await expect(rpc.request({ type: "second" })).resolves.toBe("still-working");
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(expect.stringMatching(
        /discarded oversized child RPC event frame of type "entry_appended" \(\d+ characters; transport cap 8388608\)/,
      ));
    } finally {
      errorLog.mockRestore();
    }
  }, 30_000);

  test("reports an oversized unterminated event once when stdout ends", async () => {
    const script = [
      "const { once } = require('node:events');",
      "const write = async (text) => { if (!process.stdout.write(text)) await once(process.stdout, 'drain'); };",
      "void (async () => {",
      "  await write('{\"type\":\"entry_appended\",\"entry\":{\"data\":\"');",
      "  const chunk = 'x'.repeat(256 * 1024);",
      "  for (let index = 0; index < 33; index += 1) await write(chunk);",
      "  await write(Buffer.from([0xc3]));",
      "  await new Promise((resolve) => setTimeout(resolve, 20));",
      "  await write(Buffer.from([0xa9]));",
      "})();",
    ].join(String.fromCharCode(10));
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));

      await expect(rpc.exited).resolves.toEqual({ code: 0, signal: null });
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(expect.stringMatching(
        /discarded oversized child RPC event frame of type "entry_appended" \(\d+ characters; transport cap 8388608\)/,
      ));
    } finally {
      errorLog.mockRestore();
    }
  }, 30_000);

  test("fails closed when an oversized frame prefix identifies a response", async () => {
    const script = [
      "const { once } = require('node:events');",
      "process.stdout.on('error', () => {});",
      "const write = async (text) => { if (!process.stdout.write(text)) await once(process.stdout, 'drain'); };",
      "void (async () => {",
      "  await write('{\"type\":\"response\",\"id\":\"req-1\",\"command\":\"prompt\",\"success\":true,\"data\":\"');",
      "  const chunk = 'x'.repeat(256 * 1024);",
      "  for (let index = 0; index < 33; index += 1) await write(chunk);",
      "  await write('\"}\\n');",
      "})();",
      "setInterval(() => {}, 1000);",
    ].join(String.fromCharCode(10));
    const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
    const pending = rpc.request({ type: "prompt", message: "answer" });

    await expect(pending).rejects.toBeInstanceOf(RpcFrameTooLargeError);
    await expect(pending).rejects.toThrow(`exceeded the ${RPC_MAX_FRAME_CHARS}-character transport cap`);
    expect((await rpc.exited).signal).toBe("SIGKILL");
  }, 30_000);

  test("fails closed when an oversized frame has no type discriminator in its prefix", async () => {
    const script = [
      "const { once } = require('node:events');",
      "process.stdout.on('error', () => {});",
      "const write = async (text) => { if (!process.stdout.write(text)) await once(process.stdout, 'drain'); };",
      "void (async () => {",
      "  await write('{\"padding\":\"');",
      "  const chunk = 'x'.repeat(256 * 1024);",
      "  for (let index = 0; index < 33; index += 1) await write(chunk);",
      "  await write('\",\"type\":\"entry_appended\"}\\n');",
      "})();",
      "setInterval(() => {}, 1000);",
    ].join(String.fromCharCode(10));
    const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
    const pending = rpc.request({ type: "never_answers" });

    await expect(pending).rejects.toBeInstanceOf(RpcFrameTooLargeError);
    await expect(pending).rejects.toThrow(`exceeded the ${RPC_MAX_FRAME_CHARS}-character transport cap`);
    expect((await rpc.exited).signal).toBe("SIGKILL");
  }, 30_000);

  test("fails the channel when cumulative oversized event discards exceed the hard limit", async () => {
    const script = [
      "const { once } = require('node:events');",
      "process.stdout.on('error', () => {});",
      "const write = async (text) => { if (!process.stdout.write(text)) await once(process.stdout, 'drain'); };",
      "const chunk = 'x'.repeat(1024 * 1024);",
      "const writeFrame = async (type, chunks) => {",
      "  await write('{\"type\":\"' + type + '\",\"payload\":\"');",
      "  for (let index = 0; index < chunks; index += 1) await write(chunk);",
      "  await write('\"}\\n');",
      "};",
      "void (async () => { await writeFrame('entry_appended', 257); await writeFrame('message_update', 256); })();",
      "setInterval(() => {}, 1000);",
    ].join(String.fromCharCode(10));
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
      const pending = rpc.request({ type: "never_answers" });

      await expect(pending).rejects.toBeInstanceOf(RpcFrameTooLargeError);
      await expect(pending).rejects.toThrow(/discard total exceeded the 536870912-character hard limit/);
      expect((await rpc.exited).signal).toBe("SIGKILL");
      expect(errorLog).toHaveBeenCalledTimes(2);
      expect(errorLog.mock.calls.map(([message]) => message)).toEqual([
        expect.stringContaining('type "entry_appended"'),
        expect.stringContaining('type "message_update"'),
      ]);
    } finally {
      errorLog.mockRestore();
    }
  }, 60_000);

  test("a request deadline rejects when the child never answers", async () => {
    const script = "const readline = require('node:readline'); readline.createInterface({ input: process.stdin }).on('line', () => {}); setInterval(() => {}, 1000);";
    const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
    await expect(rpc.request({ type: "get_state" }, { timeoutMs: 200 })).rejects.toThrow(/timed out after 200ms/);
  });

  test("kill reaps a same-group grandchild that holds stdout open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subprocess-rpc-group-"));
    const heartbeatPath = join(dir, "heartbeat");
    const pidPath = join(dir, "grandchild.pid");
    const grandchildScript = [
      "const { appendFileSync, writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      `setInterval(() => appendFileSync(${JSON.stringify(heartbeatPath)}, '.'), 100);`,
    ].join(String.fromCharCode(10));
    const script = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: ['ignore', 'inherit', 'ignore'] });`,
      "setInterval(() => {}, 1000);",
    ].join(String.fromCharCode(10));
    const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
    try {
      const heartbeatDeadline = Date.now() + 3_000;
      while ((!existsSync(heartbeatPath) || statSync(heartbeatPath).size < 2) && Date.now() < heartbeatDeadline) await Bun.sleep(50);
      expect(existsSync(heartbeatPath)).toBe(true);
      expect(statSync(heartbeatPath).size).toBeGreaterThanOrEqual(2);

      const started = performance.now();
      rpc.kill("SIGKILL");
      const exit = await rpc.exited;
      expect(exit.signal).toBe("SIGKILL");
      expect(performance.now() - started).toBeLessThan(2_000);

      await Bun.sleep(250);
      const stoppedSize = statSync(heartbeatPath).size;
      await Bun.sleep(750);
      expect(statSync(heartbeatPath).size).toBe(stoppedSize);
    } finally {
      if (existsSync(pidPath)) {
        try { process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL"); } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dispose escalates a still-alive SIGTERM-ignoring leader and its process group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subprocess-rpc-dispose-group-"));
    const heartbeatPath = join(dir, "heartbeat");
    const pidPath = join(dir, "grandchild.pid");
    const grandchildScript = [
      "const { appendFileSync, writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "writeFileSync(" + JSON.stringify(pidPath) + ", String(process.pid));",
      "setInterval(() => appendFileSync(" + JSON.stringify(heartbeatPath) + ", '.'), 100);",
    ].join(String.fromCharCode(10));
    const script = [
      "const { spawn } = require('node:child_process');",
      "process.on('SIGTERM', () => {});",
      "spawn(process.execPath, ['-e', " + JSON.stringify(grandchildScript) + "], { stdio: ['ignore', 'inherit', 'ignore'] });",
      "setInterval(() => {}, 1000);",
    ].join(String.fromCharCode(10));
    const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    try {
      const heartbeatDeadline = Date.now() + 3_000;
      while ((!existsSync(heartbeatPath) || statSync(heartbeatPath).size < 2) && Date.now() < heartbeatDeadline) await Bun.sleep(50);
      expect(existsSync(heartbeatPath)).toBe(true);
      expect(statSync(heartbeatPath).size).toBeGreaterThanOrEqual(2);

      await expect(session.dispose()).resolves.toBeUndefined();
      expect((await rpc.exited).signal).toBe("SIGKILL");
      await Bun.sleep(250);
      const stoppedSize = statSync(heartbeatPath).size;
      await Bun.sleep(750);
      expect(statSync(heartbeatPath).size).toBe(stoppedSize);
    } finally {
      if (existsSync(pidPath)) {
        try { process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL"); } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("onExit fires immediately when subscribing after exit", async () => {
    const rpc = spawnFake();
    rpc.kill("SIGKILL");
    await rpc.exited;
    let fired: RpcExit | undefined;
    rpc.onExit((exit) => { fired = exit; });
    expect(fired?.signal).toBe("SIGKILL");
  });
});
