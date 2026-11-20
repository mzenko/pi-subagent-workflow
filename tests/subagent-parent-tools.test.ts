import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ParentContext } from "../src/runner/child.js";
import type { ChildSession } from "../src/runner/child-session.js";
import { SubagentRunner } from "../src/runner/runner.js";
import { Semaphore } from "../src/runner/semaphore.js";
import { RunStore } from "../src/store/run-store.js";
import { registerSubagentMessageTool } from "../src/tool/subagent-message-tool.js";
import { registerSubagentStopTool } from "../src/tool/subagent-stop-tool.js";
import { formatDelivery } from "../src/tool/subagent-tool.js";
import type { ResolvedSpec, SubagentResult } from "../src/types.js";

const resolved: ResolvedSpec = { provider: "test", modelId: "tiny", thinkingLevel: "off", tools: [], cwd: "/tmp", label: "child" };
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });

function parent(sessionId = "parent"): ParentContext {
  return { ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;
}

function temporaryStore(runId: string, owner: ParentContext): RunStore {
  return new RunStore(runId, owner.ctx.cwd, "parent", undefined, { rootDir: mkdtempSync(join(tmpdir(), "subagent-message-")) });
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/**
 * A child session whose turn stays open until `finishTurn()`. `deliver(text)`
 * simulates pi injecting a queued steer into the conversation.
 */
function controllableSession(options: { steer?: (text: string) => Promise<void>; dispose?: () => Promise<void> } = {}) {
  const steered: string[] = [];
  const turn = gate();
  const started = gate();
  let listener: ((event: unknown) => void) | undefined;
  const session = {
    sessionFile: "/child.jsonl",
    latestAssistant: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop" },
    usage: zeroUsage(),
    subscribe: (next: (event: unknown) => void) => { listener = next; return () => { listener = undefined; }; },
    prompt: async () => { started.open(); await turn.promise; },
    steer: options.steer ?? (async (text: string) => { steered.push(text); }),
    abort: async () => { turn.open(); },
    dispose: options.dispose ?? (async () => {}),
  } as unknown as ChildSession;
  return {
    session,
    steered,
    started: started.promise,
    finishTurn: turn.open,
    deliver: (text: string) => listener?.({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } }),
  };
}

function runnerFor(session: ChildSession, semaphore = new Semaphore(1)): SubagentRunner {
  return new SubagentRunner(async () => ({ session, resolved }), semaphore, temporaryStore);
}

test("a parent message is wrapped, queued, and confirmed when it enters the child conversation", async () => {
  const child = controllableSession();
  const runner = runnerFor(child.session);
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  await child.started;

  const receipt = await runner.messageChild(handle.id, "parent", "also check the tests");
  expect(receipt).toEqual({ childId: handle.id, messageId: "m1", delivery: "queued" });
  expect(child.steered).toEqual(["[Message m1 from your parent agent]\nalso check the tests"]);

  child.deliver(child.steered[0]!);
  child.finishTurn();
  const result = await handle.result;
  expect(result.status).toBe("completed");
  expect(result.unconfirmedMessages).toBeUndefined();
});

test("a message the child never reads is reported as unconfirmed in its result", async () => {
  const child = controllableSession();
  const runner = runnerFor(child.session);
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  await child.started;

  await runner.messageChild(handle.id, "parent", "first");
  await runner.messageChild(handle.id, "parent", `second ${"x".repeat(200)}`);
  child.deliver(child.steered[0]!);
  child.finishTurn();
  const result = await handle.result;

  expect(result.unconfirmedMessages).toHaveLength(1);
  expect(result.unconfirmedMessages![0]!.messageId).toBe("m2");
  expect(result.unconfirmedMessages![0]!.preview.length).toBeLessThanOrEqual(80);
  expect(result.unconfirmedMessages![0]!.preview.startsWith("second x")).toBe(true);
});

test("identical message text is confirmed once per arrival, never by the original prompt", async () => {
  const child = controllableSession();
  const runner = runnerFor(child.session);
  const handle = runner.spawnRun({ prompt: "same" }, parent(), { acceptsParentMessages: true });
  await child.started;

  await runner.messageChild(handle.id, "parent", "same");
  await runner.messageChild(handle.id, "parent", "same");
  child.deliver("same");
  child.deliver(child.steered[1]!);
  child.finishTurn();
  const result = await handle.result;

  expect(result.unconfirmedMessages?.map((message) => message.messageId)).toEqual(["m1"]);
});

test("a message to a queued child is buffered and reaches it after construction", async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire(new AbortController().signal);
  const child = controllableSession();
  const runner = runnerFor(child.session, semaphore);
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });

  const receipt = await runner.messageChild(handle.id, "parent", "context for later");
  expect(receipt.delivery).toBe("buffered");
  expect(child.steered).toEqual([]);

  release();
  await child.started;
  expect(child.steered).toEqual(["[Message m1 from your parent agent]\ncontext for later"]);
  child.deliver(child.steered[0]!);
  child.finishTurn();
  expect((await handle.result).unconfirmedMessages).toBeUndefined();
});

test("a buffered message is reported when the queued child is aborted before it starts", async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire(new AbortController().signal);
  const child = controllableSession();
  const runner = runnerFor(child.session, semaphore);
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });

  await runner.messageChild(handle.id, "parent", "never read");
  await handle.abort();
  const result = await handle.result;
  release();

  expect(result.status).toBe("aborted");
  expect(result.unconfirmedMessages?.map((message) => message.messageId)).toEqual(["m1"]);
});

test("a message sent while buffered messages are being handed over queues behind them", async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire(new AbortController().signal);
  const firstAck = gate();
  const firstSent = gate();
  const sent: string[] = [];
  const child = controllableSession({
    steer: async (text) => {
      sent.push(text);
      if (sent.length === 1) { firstSent.open(); await firstAck.promise; }
    },
  });
  const runner = runnerFor(child.session, semaphore);
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  await runner.messageChild(handle.id, "parent", "one");
  await runner.messageChild(handle.id, "parent", "two");

  release();
  await firstSent.promise;
  const third = await runner.messageChild(handle.id, "parent", "three");
  expect(third.delivery).toBe("buffered");
  firstAck.open();
  await child.started;

  expect(sent.map((text) => text.split("]")[0])).toEqual(["[Message m1 from your parent agent", "[Message m2 from your parent agent", "[Message m3 from your parent agent"]);
  child.finishTurn();
  await handle.result;
});

test("a stopped child that restarts on an unread message is aborted again and settles as aborted", async () => {
  let listener: ((event: unknown) => void) | undefined;
  const turn = gate();
  const started = gate();
  let aborts = 0;
  const session = {
    sessionFile: "/child.jsonl",
    latestAssistant: { role: "assistant", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "aborted" },
    usage: zeroUsage(),
    subscribe: (next: (event: unknown) => void) => { listener = next; return () => { listener = undefined; }; },
    prompt: async () => { started.open(); await turn.promise; },
    steer: async () => {},
    // pi keeps the queued steer through abort and continues on it: the first
    // abort starts a fresh run that injects the steer; only the second abort
    // lets the turn settle.
    abort: async () => {
      aborts += 1;
      if (aborts === 1) {
        listener?.({ type: "agent_start" });
        listener?.({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "[Message m1 from your parent agent]\nunread" }] } });
      } else turn.open();
    },
    dispose: async () => {},
  } as unknown as ChildSession;
  // The settle grace never elapses, so only the re-abort can end this test.
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore, () => new Promise(() => {}));
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  await started.promise;
  await runner.messageChild(handle.id, "parent", "unread");

  await handle.abort();
  const result = await handle.result;
  expect(aborts).toBe(2);
  expect(result.status).toBe("aborted");
  // It entered the conversation before the re-abort: confirmed, not acted on.
  expect(result.unconfirmedMessages).toBeUndefined();
});

test("stopping a child mid-flush sends no more of the buffered backlog", async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire(new AbortController().signal);
  const firstAck = gate();
  const firstSent = gate();
  const sent: string[] = [];
  const child = controllableSession({
    steer: async (text) => {
      sent.push(text);
      if (sent.length === 1) { firstSent.open(); await firstAck.promise; }
    },
  });
  const runner = runnerFor(child.session, semaphore);
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  for (const text of ["one", "two", "three"]) await runner.messageChild(handle.id, "parent", text);

  release();
  await firstSent.promise;
  const stopping = handle.abort();
  firstAck.open();
  await stopping;
  const result = await handle.result;

  expect(sent).toHaveLength(1);
  expect(result.status).toBe("aborted");
  expect(result.unconfirmedMessages?.map((message) => message.messageId)).toEqual(["m1", "m2", "m3"]);
});

test("a failed buffered flush leaves the message unconfirmed without failing the child", async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire(new AbortController().signal);
  const child = controllableSession({ steer: async () => { throw new Error("rpc timeout"); } });
  const runner = runnerFor(child.session, semaphore);
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });

  await runner.messageChild(handle.id, "parent", "lost in transit");
  release();
  await child.started;
  child.finishTurn();
  const result = await handle.result;

  expect(result.status).toBe("completed");
  expect(result.unconfirmedMessages?.map((message) => message.messageId)).toEqual(["m1"]);
});

test("a rejected send is an error and is not tracked", async () => {
  const child = controllableSession({ steer: async () => { throw new Error("child exited"); } });
  const runner = runnerFor(child.session);
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  await child.started;

  await expect(runner.messageChild(handle.id, "parent", "hello")).rejects.toThrow("child exited");
  child.finishTurn();
  expect((await handle.result).unconfirmedMessages).toBeUndefined();
});

test("messages are refused once the child is finishing, before its result exists", async () => {
  const disposal = gate();
  const disposing = gate();
  const child = controllableSession({ dispose: async () => { disposing.open(); await disposal.promise; } });
  const runner = runnerFor(child.session);
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  await child.started;
  child.finishTurn();
  await disposing.promise;

  await expect(runner.messageChild(handle.id, "parent", "late")).rejects.toThrow("is finishing");
  await expect(handle.steer("late human steer")).rejects.toThrow("is finishing");
  disposal.open();
  const result = await handle.result;
  expect(result.unconfirmedMessages).toBeUndefined();
  await expect(handle.steer("after the end")).rejects.toThrow("has finished");
});

test("a finished child gets an error with continuation advice, not a silent buffer", async () => {
  const child = controllableSession();
  const runner = runnerFor(child.session);
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  await child.started;
  child.finishTurn();
  await handle.result;

  // Still registered until delivery retires it.
  await expect(runner.messageChild(handle.id, "parent", "late")).rejects.toThrow(/has finished.*followUp/);
});

test("only this session's subagent-tool children are addressable", async () => {
  const child = controllableSession();
  const runner = runnerFor(child.session);
  const own = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  await child.started;

  await expect(runner.messageChild(own.id, "other-session", "hi")).rejects.toThrow("No live subagent");
  await expect(runner.messageChild("subagent-missing", "parent", "hi")).rejects.toThrow("No live subagent");
  // The run id resolves to its single child.
  expect((await runner.messageChild(own.runId, "parent", "by run id")).childId).toBe(own.id);
  child.finishTurn();
  await own.result;

  const workflowChild = controllableSession();
  const workflowRunner = runnerFor(workflowChild.session);
  const internal = workflowRunner.spawnRun({ prompt: "work" }, parent());
  await workflowChild.started;
  await expect(workflowRunner.messageChild(internal.id, "parent", "hi")).rejects.toThrow("was not started by the subagent tool");
  workflowChild.finishTurn();
  await internal.result;
});

test("the delivery envelope warns about unconfirmed messages with their ids", () => {
  const result: SubagentResult = {
    id: "child-1", generation: 1, status: "completed", text: "done", usage: zeroUsage(), resolved,
    unconfirmedMessages: [{ messageId: "m2", preview: "switch to plan B" }],
  };
  const text = formatDelivery("run-1", "/runs/run-1", result);
  expect(text).toContain("Warning: 1 parent message was not confirmed delivered to child child-1 before it stopped (m2 \"switch to plan B\")");
  expect(text).toContain("subagent followUp");
  expect(formatDelivery("run-1", "/runs/run-1", { ...result, unconfirmedMessages: undefined })).not.toContain("not confirmed delivered");
});

test("subagent_message rejects blank input, forwards text as written, scopes the call to the parent session, and returns a receipt", async () => {
  let registered: ToolDefinition<any, any, any> | undefined;
  const calls: unknown[] = [];
  const pi = { registerTool: (tool: ToolDefinition<any, any, any>) => { registered = tool; } } as unknown as ExtensionAPI;
  const runner = {
    messageChild: async (target: string, sessionId: string, text: string) => {
      calls.push([target, sessionId, text]);
      return { childId: "child-1", messageId: "m1", delivery: "queued" as const };
    },
  } as unknown as SubagentRunner;
  registerSubagentMessageTool(pi, runner);
  const ctx = { sessionManager: { getSessionId: () => "parent" } };

  expect(registered!.name).toBe("subagent_message");
  const output = await registered!.execute("call-1", { id: " child-1 ", message: "    indented()\nnarrow to src/" }, undefined, undefined, ctx as never);
  expect(calls).toEqual([["child-1", "parent", "    indented()\nnarrow to src/"]]);
  expect(JSON.parse((output.content[0] as { text: string }).text)).toMatchObject({ id: "child-1", messageId: "m1", status: "queued" });

  await expect(registered!.execute("call-2", { id: "child-1", message: "   " }, undefined, undefined, ctx as never)).rejects.toThrow("must not be empty");
  expect(calls).toHaveLength(1);
});

test("subagent_stop stops this session's subagent by child id or run id and refuses others", async () => {
  const first = controllableSession();
  const runner = runnerFor(first.session);
  const own = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  await first.started;

  await expect(runner.stopForParent(own.id, "other-session")).rejects.toThrow("No running subagent or workflow");
  expect(await runner.stopForParent(own.id, "parent")).toEqual({ runId: own.runId, kind: "subagent", status: "stopped" });
  expect((await own.result).status).toBe("aborted");
  // Settled: a second stop finds nothing live.
  await expect(runner.stopForParent(own.runId, "parent")).rejects.toThrow("may already have finished");

  const second = controllableSession();
  const byRun = runnerFor(second.session);
  const handle = byRun.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  await second.started;
  expect(await byRun.stopForParent(handle.runId, "parent")).toEqual({ runId: handle.runId, kind: "subagent", status: "stopped" });
  expect((await handle.result).status).toBe("aborted");
});

test("subagent_stop does not claim to stop a child whose prompt already returned", async () => {
  const disposal = gate();
  const disposing = gate();
  const child = controllableSession({ dispose: async () => { disposing.open(); await disposal.promise; } });
  const runner = runnerFor(child.session);
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  await child.started;
  child.finishTurn();
  await disposing.promise;

  // Still "running" while the session shuts down, but the outcome is fixed.
  expect(await runner.stopForParent(handle.id, "parent")).toEqual({ runId: handle.runId, kind: "subagent", status: "already-finished" });
  disposal.open();
  expect((await handle.result).status).toBe("completed");
});

test("subagent_stop stops a child still queued for admission", async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire(new AbortController().signal);
  const child = controllableSession();
  const runner = runnerFor(child.session, semaphore);
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  expect(handle.status).toBe("pending");

  expect(await runner.stopForParent(handle.id, "parent")).toEqual({ runId: handle.runId, kind: "subagent", status: "stopped" });
  expect((await handle.result).status).toBe("aborted");
  release();
});

test("subagent_stop reports a child that ignored the stop and was terminated", async () => {
  const started = gate();
  const session = {
    sessionFile: "/child.jsonl",
    latestAssistant: undefined,
    usage: zeroUsage(),
    subscribe: () => () => {},
    prompt: async () => { started.open(); await new Promise(() => {}); },
    steer: async () => {},
    abort: async () => {},
    dispose: async () => {},
  } as unknown as ChildSession;
  // The settle grace elapses at once, so the stuck child is abandoned.
  const runner = new SubagentRunner(async () => ({ session, resolved }), new Semaphore(1), temporaryStore, async () => {});
  const handle = runner.spawnRun({ prompt: "work" }, parent(), { acceptsParentMessages: true });
  await started.promise;

  const stopped = await runner.stopForParent(handle.id, "parent");
  expect(stopped).toMatchObject({ runId: handle.runId, kind: "subagent", status: "terminated" });
  expect(stopped.error).toContain("did not settle");
  expect((await handle.result).status).toBe("failed");
});

test("subagent_stop refuses an individual workflow child and points at the run id", async () => {
  const child = controllableSession();
  const runner = runnerFor(child.session);
  const internal = runner.spawnRun({ prompt: "work" }, parent());
  await child.started;

  // Without a workflow controller this is a private /agents follow-up.
  await expect(runner.stopForParent(internal.id, "parent")).rejects.toThrow("can stop it from /agents");
  runner.registerRunController(internal.runId, new AbortController(), "other-session", Promise.resolve());
  await expect(runner.stopForParent(internal.id, "parent")).rejects.toThrow(`pass its runId (${internal.runId})`);
  child.finishTurn();
  expect((await internal.result).status).toBe("completed");
});

test("subagent_stop cancels this session's workflow loop and waits for it to settle", async () => {
  const runner = runnerFor(controllableSession().session);
  const controller = new AbortController();
  let settled = false;
  const execution = new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => { setTimeout(() => { settled = true; resolve(); }, 5); });
  });
  runner.registerRunController("flow-1", controller, "parent", execution);

  await expect(runner.stopForParent("flow-1", "other-session")).rejects.toThrow("No running subagent or workflow");
  expect(controller.signal.aborted).toBe(false);
  expect(await runner.stopForParent("flow-1", "parent")).toEqual({ runId: "flow-1", kind: "workflow", status: "stopped" });
  expect(controller.signal.aborted).toBe(true);
  expect(settled).toBe(true);
});

test("subagent_stop tool scopes the call to the parent session and reports the stopped run", async () => {
  let registered: ToolDefinition<any, any, any> | undefined;
  const calls: unknown[] = [];
  const pi = { registerTool: (tool: ToolDefinition<any, any, any>) => { registered = tool; } } as unknown as ExtensionAPI;
  const runner = {
    stopForParent: async (target: string, sessionId: string) => {
      calls.push([target, sessionId]);
      return { runId: "flow-1", kind: "workflow" as const, status: "stopped" as const };
    },
  } as unknown as SubagentRunner;
  registerSubagentStopTool(pi, runner);

  expect(registered!.name).toBe("subagent_stop");
  const output = await registered!.execute("call-1", { id: " flow-1 " }, undefined, undefined, { sessionManager: { getSessionId: () => "parent" } } as never);
  expect(calls).toEqual([["flow-1", "parent"]]);
  expect(JSON.parse((output.content[0] as { text: string }).text)).toEqual({ runId: "flow-1", kind: "workflow", status: "stopped" });
});
