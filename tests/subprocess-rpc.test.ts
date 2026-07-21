import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildArgs } from "../src/runner/subprocess/child-args.js";
import { RpcChildSession } from "../src/runner/subprocess/rpc-child-session.js";
import { spawnChildRpc, type ChildRpc, type RpcExit } from "../src/runner/subprocess/rpc-transport.js";

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
    request(command) {
      if (exited) return Promise.reject(new Error("already exited"));
      sent.push(command);
      const type = command.type as string;
      if (responders.has(type)) {
        const scripted = responders.get(type);
        if (typeof scripted === "function") return Promise.resolve((scripted as () => unknown)());
        return scripted instanceof Error ? Promise.reject(scripted) : Promise.resolve(scripted);
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
    rpc.respond("get_state", { sessionFile: "/sessions/child.jsonl" });
    const session = await RpcChildSession.start(rpc);
    expect(session.sessionFile).toBe("/sessions/child.jsonl");
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
    rpc.emit({ type: "agent_settled" });
    await turn;
    expect(resolved).toBe(true);
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

  test("forwards events to subscribers until unsubscribed", () => {
    const rpc = fakeRpc();
    const session = new RpcChildSession(rpc, { sessionFile: undefined });
    const seen: string[] = [];
    const unsubscribe = session.subscribe((event) => seen.push((event as { type: string }).type));
    rpc.emit({ type: "tool_execution_start" });
    unsubscribe();
    rpc.emit({ type: "tool_execution_end" });
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
    await Bun.sleep(10);
    expect(rpc.killed).toEqual(["SIGTERM"]);
    expect(resolved).toBe(false);
    rpc.exit({ code: null, signal: "SIGTERM" });
    await disposal;
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

  test("correlates responses, fans out events, and reports failure responses", async () => {
    const rpc = spawnFake();
    const events: string[] = [];
    rpc.onEvent((event) => events.push(event.type as string));
    const state = await rpc.request({ type: "get_state" }) as { sessionFile: string };
    expect(state.sessionFile).toBe("/tmp/x.jsonl");
    await expect(rpc.request({ type: "explode" })).rejects.toThrow("no such command");
    expect(events).toContain("hello_event");
  });

  test("rejects in-flight and later requests when the child exits, with stderr context", async () => {
    const script = `
      console.log(JSON.stringify({ type: "response", id: "req-1", command: "get_state", success: true, data: { sessionFile: "/tmp/x.jsonl" } }));
      setTimeout(() => { process.stderr.write("dying now"); process.exit(3); }, 100);
    `;
    const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
    await rpc.request({ type: "get_state" });
    const dead = rpc.request({ type: "die" });
    await expect(dead).rejects.toThrow(/code 3.*dying now/s);
    const exit = await rpc.exited;
    expect(exit.code).toBe(3);
    await expect(rpc.request({ type: "get_state" })).rejects.toThrow(/already closed/);
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

  test("discards an oversized frame across chunks and parses events and responses after its mid-chunk newline", async () => {
    const script = [
      "const { once } = require('node:events');",
      "const write = async (text) => { if (!process.stdout.write(text)) await once(process.stdout, 'drain'); };",
      "void (async () => {",
      "  await write('{\"type\":\"message_end\",\"message\":{\"role\":\"toolResult\",\"content\":\"');",
      "  const chunk = 'x'.repeat(256 * 1024);",
      "  for (let index = 0; index < 33; index += 1) await write(chunk);",
      "  await write('\"}}\\n' + JSON.stringify({ type: 'small_event' }) + '\\n' + JSON.stringify({ type: 'agent_settled' }) + '\\n' + JSON.stringify({ type: 'response', id: 'req-1', command: 'get_state', success: true, data: { ready: true } }) + '\\n');",
      "  setTimeout(() => void write(JSON.stringify({ type: 'response', id: 'req-2', command: 'second', success: true, data: 'still-working' }) + '\\n'), 100);",
      "})();",
      "setInterval(() => {}, 1000);",
    ].join(String.fromCharCode(10));
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
      const events: string[] = [];
      rpc.onEvent((event) => events.push(event.type as string));
      const pending = rpc.request({ type: "get_state" });

      await expect(pending).resolves.toEqual({ ready: true });
      expect(events).toContain("small_event");
      expect(events).toContain("agent_settled");
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(expect.stringMatching(/discarded oversized child RPC frame.*approximately \d+ characters.*buffer cap 8388608/i));

      rpc.send({ type: "extension_ui_response", id: "ui-1" });
      await expect(rpc.request({ type: "second" })).resolves.toBe("still-working");
    } finally {
      errorLog.mockRestore();
    }
  });

  test("drops and diagnoses an oversized partial frame when stdout ends", async () => {
    const script = "process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));";
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
      await expect(rpc.exited).resolves.toEqual({ code: 0, signal: null });
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(expect.stringMatching(/discarded oversized child RPC frame/i));
    } finally {
      errorLog.mockRestore();
    }
  });

  test("kills a child whose unterminated frame exceeds the hard discard limit", async () => {
    const script = [
      "const { once } = require('node:events');",
      "process.stdout.on('error', () => {});",
      "const chunk = 'x'.repeat(1024 * 1024);",
      "void (async () => {",
      "  for (let index = 0; index < 513; index += 1) {",
      "    if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');",
      "  }",
      "})();",
      "setInterval(() => {}, 1000);",
    ].join(String.fromCharCode(10));
    const rpc = tracked(spawnChildRpc([process.execPath, "-e", script], { cwd: process.cwd() }));
    const pending = rpc.request({ type: "never_answers" });

    await expect(pending).rejects.toThrow(/8388608-character buffer cap.*536870912-character hard discard limit.*discarded \d+ characters without a newline/s);
    expect((await rpc.exited).signal).toBe("SIGKILL");
  }, 30_000);

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
