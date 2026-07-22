import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { parseKey, type TUI } from "@earendil-works/pi-tui";
import type { ChildSession, ChildSessionEvent } from "../src/runner/child-session.js";
import type { SubagentHandle, SubagentStatus } from "../src/types.js";
import { AgentView } from "../src/ui/navigator/agent-view.js";
import { keyToAction } from "../src/ui/navigator/controls.js";
import { PLAIN } from "../src/ui/format.js";
import type { NavigatorModel } from "../src/ui/navigator/model.js";
import { buildAgentView, saveRefusalMessage, type NavigatorRunner } from "../src/ui/navigator/navigator.js";
import type { RunDetail } from "../src/ui/navigator/store-read.js";
import type { TranscriptMessage } from "../src/ui/navigator/transcript.js";

test("agent transcript header sanitizes child label and model", () => {
  const view = new AgentView({
    tui: { requestRender: () => {} } as unknown as TUI,
    header: () => ({
      label: "safe\u001b[2Jlabel\u0007",
      model: "model\u001b]0;owned\u0007name",
      status: "completed",
      tokens: 12,
    }),
    messages: () => [],
    live: () => false,
  });

  const rendered = view.render(100, 4, PLAIN).join("\n");
  expect(rendered).toContain("safelabel");
  expect(rendered).toContain("modelname");
  expect(rendered).not.toContain("\u001b");
  expect(rendered).not.toContain("\u0007");
});

test("x on a completed agent falls through to the navigator's run-stop action", () => {
  const view = new AgentView({
    tui: { requestRender: () => {} } as unknown as TUI,
    header: () => ({ label: "child", model: "test", status: "completed", tokens: 0 }),
    messages: () => [],
    live: () => false,
  });

  expect(view.handleInput("", "x")).toBe(false);
  expect(keyToAction("x", "agent")).toEqual({ type: "stop" });
});

test("tab falls through for live-run cycling unless the steering composer is focused", () => {
  const view = new AgentView({
    tui: { requestRender: () => {} } as unknown as TUI,
    header: () => ({ label: "child", model: "test", status: "running", tokens: 0 }),
    messages: () => [],
    live: () => true,
    onSteer: () => {},
  });

  expect(view.handleInput("\t", "tab")).toBe(false);
  expect(view.handleInput("\r", "return")).toBe(true);
  expect(view.handleInput("\t", "tab")).toBe(true);
});

test("a rejected follow-up keeps the message composer and draft", () => {
  const submitted: string[] = [];
  const view = new AgentView({
    tui: { requestRender: () => {} } as unknown as TUI,
    header: () => ({ label: "child", model: "test", status: "completed", tokens: 0 }),
    messages: () => [],
    live: () => false,
    canMessage: () => true,
    onMessage: (text) => { submitted.push(text); return false; },
  });

  expect(view.canMessage).toBe(true);
  expect(view.handleInput("\r", "return")).toBe(true);
  expect(view.handleInput("keep this draft", undefined)).toBe(true);
  expect(view.handleInput("\r", "return")).toBe(true);
  expect(submitted).toEqual(["keep this draft"]);
  expect(view.composerOpen).toBe(true);
  expect(view.render(80, 6, PLAIN).join("\n")).toContain("keep this draft");
});

test("a steer draft becomes a follow-up when the child completes before submit", () => {
  let status: SubagentStatus = "running";
  let live = true;
  const steered: string[] = [];
  const messaged: string[] = [];
  const view = new AgentView({
    tui: { requestRender: () => {} } as unknown as TUI,
    header: () => ({ label: "child", model: "test", status, tokens: 0 }),
    messages: () => [],
    live: () => live,
    onSteer: (text) => { steered.push(text); },
    canMessage: () => status === "completed",
    onMessage: (text) => { messaged.push(text); return true; },
  });

  expect(view.handleInput("\r", "return")).toBe(true);
  expect(view.handleInput("continue from here", undefined)).toBe(true);
  status = "completed";
  live = false;
  expect(view.render(80, 6, PLAIN).join("\n")).toContain("✎ message:");
  expect(view.handleInput("\r", "return")).toBe(true);

  expect(steered).toEqual([]);
  expect(messaged).toEqual(["continue from here"]);
  expect(view.composerOpen).toBe(false);
});

test("agent view caches a bounded dense transcript between unchanged renders", () => {
  let contentReads = 0;
  const dense = "x\n".repeat(4_000);
  const message: TranscriptMessage = {
    role: "assistant",
    get content() {
      contentReads += 1;
      return dense;
    },
  };
  const messages = [message];
  const view = new AgentView({
    tui: { requestRender: () => {} } as unknown as TUI,
    header: () => ({ label: "child", model: "test", status: "completed", tokens: 0 }),
    messages: () => messages,
    live: () => false,
  });

  expect(view.render(80, 6, PLAIN).join("\n")).toContain("x");
  const readsAfterFirstRender = contentReads;
  expect(readsAfterFirstRender).toBeGreaterThan(0);
  view.render(80, 6, PLAIN);
  view.handleInput("", "home");
  expect(view.render(80, 6, PLAIN).join("\n")).toContain("(transcript elided)");
  view.handleInput("", "pageup");
  view.render(80, 6, PLAIN);
  expect(contentReads).toBe(readsAfterFirstRender);
});

test("a queued agent accepts steer and stop controls before its session is ready", async () => {
  let status: SubagentStatus = "pending";
  let liveSession: ChildSession | undefined;
  let sessionListener: (() => void) | undefined;
  let renderRequests = 0;
  let aborts = 0;
  const steers: string[] = [];
  const sessionPath = join(mkdtempSync(join(tmpdir(), "nav-agent-view-")), "child.jsonl");
  const handle = {
    status: "pending",
    steer: async (text: string) => { steers.push(text); },
    abort: async () => { aborts += 1; },
  } as unknown as SubagentHandle;
  const runner = {
    liveSession: () => liveSession,
    get: () => handle,
  } as unknown as NavigatorRunner;
  const model = {
    detail: () => ({
      runId: "run-1", runDir: "/run-1", kind: "subagent", label: "run", status,
      phases: [], narrator: [], hasScript: false, corrupt: false,
      children: [{ id: "child-1", label: "child", model: "test", status, tokens: 0, spec: { prompt: "work" } }],
    }),
  } as unknown as NavigatorModel;
  const view = buildAgentView(
    runner,
    { requestRender: () => { renderRequests += 1; } } as unknown as TUI,
    model,
    "run-1",
    "child-1",
  );

  expect(view.canSteer).toBe(true);
  expect(view.canStop).toBe(true);
  expect(view.render(80, 6, PLAIN).join("\n")).toContain("(no transcript yet)");

  expect(view.handleInput("", "enter")).toBe(true);
  expect(view.handleInput("queued steer", undefined)).toBe(true);
  expect(view.handleInput("\r", "return")).toBe(true);
  await Promise.resolve();
  expect(steers).toEqual(["queued steer"]);

  expect(view.handleInput("", "x")).toBe(true);
  expect(view.handleInput("", "x")).toBe(true);
  await Promise.resolve();
  expect(aborts).toBe(1);

  status = "running";
  handle.status = "running";
  writeFileSync(sessionPath, `${JSON.stringify({ type: "message", message: { role: "assistant", content: "session is live" } })}\n`);
  liveSession = {
    sessionFile: sessionPath,
    latestAssistant: undefined,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    subscribe: (listener: () => void) => { sessionListener = listener; return () => { sessionListener = undefined; }; },
  } as unknown as ChildSession;

  expect(view.render(80, 6, PLAIN).join("\n")).toContain("session is live");
  expect(view.canSteer).toBe(true);
  appendFileSync(sessionPath, `${JSON.stringify({ type: "message", message: { role: "assistant", content: "new transcript event" } })}\n`);
  const rendersBeforeSessionEvent = renderRequests;
  sessionListener?.();
  expect(renderRequests).toBe(rendersBeforeSessionEvent + 1);
  expect(view.render(80, 6, PLAIN).join("\n")).toContain("new transcript event");

  expect(view.handleInput("", "x")).toBe(true);
  expect(view.isStopArmed).toBe(true);
  expect(view.handleInput("", "x")).toBe(true);
  expect(aborts).toBe(2);
  view.dispose();
});

function assistantMessage(text: string, timestamp: number, responseId?: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "tiny",
    responseId,
    stopReason: "stop",
    timestamp,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function liveTranscriptHarness(sessionPath: string): {
  view: AgentView;
  emit: (event: ChildSessionEvent) => void;
  messages: () => TranscriptMessage[];
  renders: () => number;
  setCurrent: (message: AssistantMessage | undefined) => void;
  setStatus: (status: SubagentStatus) => void;
} {
  let currentAssistant: AssistantMessage | undefined;
  let status: SubagentStatus = "running";
  let renderRequests = 0;
  const listeners = new Set<(event: ChildSessionEvent) => void>();
  const session = {
    sessionFile: sessionPath,
    get currentAssistant() { return currentAssistant; },
    subscribe(listener: (event: ChildSessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ChildSession;
  const handle = {
    get status() { return status; },
    steer: async () => {},
    abort: async () => {},
  } as unknown as SubagentHandle;
  const runner = {
    liveSession: () => session,
    get: () => handle,
  } as unknown as NavigatorRunner;
  const model = {
    detail: () => ({
      runId: "run-1", runDir: "/run-1", kind: "subagent", label: "run", status,
      phases: [], narrator: [], hasScript: false, corrupt: false,
      children: [{ id: "child-1", label: "child", model: "test", status, tokens: 0, sessionFile: sessionPath, spec: { prompt: "work" } }],
    }),
  } as unknown as NavigatorModel;
  const view = buildAgentView(
    runner,
    { requestRender: () => { renderRequests += 1; } } as unknown as TUI,
    model,
    "run-1",
    "child-1",
  );
  return {
    view,
    emit(event) {
      // Mirrors RpcChildSession: the retained assistant survives non-assistant
      // lifecycle events and only agent_settled clears it.
      if ((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && "message" in event && event.message.role === "assistant") {
        currentAssistant = event.message;
      } else if (event.type === "agent_settled") currentAssistant = undefined;
      for (const listener of listeners) listener(event);
    },
    messages: () => (view as unknown as { deps: { messages: () => TranscriptMessage[] } }).deps.messages(),
    renders: () => renderRequests,
    setCurrent: (message) => { currentAssistant = message; },
    setStatus: (next) => { status = next; },
  };
}

test("running agent transcripts stream assistant updates and tool results", () => {
  const sessionPath = join(mkdtempSync(join(tmpdir(), "nav-live-transcript-")), "child.jsonl");
  writeFileSync(sessionPath, `${JSON.stringify({ type: "message", message: { role: "user", content: "question", timestamp: 1 } })}\n`);
  const harness = liveTranscriptHarness(sessionPath);
  const initial = assistantMessage("working", 2, "response-2");
  harness.emit({ type: "message_start", message: initial });
  expect(harness.view.render(80, 12, PLAIN).join("\n")).toContain("working");

  const updated = assistantMessage("working now", 2, "response-2");
  const beforeUpdate = harness.renders();
  harness.emit({
    type: "message_update",
    message: updated,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " now", partial: updated } as AssistantMessageEvent,
  });
  expect(harness.renders()).toBe(beforeUpdate + 1);
  expect(harness.view.render(80, 12, PLAIN).join("\n")).toContain("working now");

  appendFileSync(sessionPath, `${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "bash", content: "tool finished", timestamp: 3 } })}\n`);
  const beforeToolEnd = harness.renders();
  harness.emit({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: "tool finished", isError: false });
  expect(harness.renders()).toBe(beforeToolEnd + 1);
  expect(harness.view.render(80, 12, PLAIN).join("\n")).toContain("tool finished");

  // A toolResult lifecycle between assistant steps must not drop the live
  // assistant from the transcript; only agent_settled hands rendering back
  // to the persisted file.
  const toolMessage = { role: "toolResult", toolName: "bash", content: "tool finished", timestamp: 3 };
  harness.emit({ type: "message_start", message: toolMessage as never });
  harness.emit({ type: "message_end", message: toolMessage as never });
  expect(harness.view.render(80, 12, PLAIN).join("\n")).toContain("working now");
  harness.view.dispose();
});

test("live transcript splices preserve identity between assistant deltas", () => {
  const sessionPath = join(mkdtempSync(join(tmpdir(), "nav-live-cache-")), "child.jsonl");
  writeFileSync(sessionPath, `${JSON.stringify({ type: "message", message: { role: "user", content: "question", timestamp: 1 } })}\n`);
  const harness = liveTranscriptHarness(sessionPath);
  let contentReads = 0;
  const current = assistantMessage("working", 2, "response-2");
  Object.defineProperty(current, "content", {
    enumerable: true,
    get() {
      contentReads += 1;
      return [{ type: "text", text: "working" }];
    },
  });
  harness.setCurrent(current);

  const first = harness.messages();
  expect(harness.messages()).toBe(first);
  expect(harness.view.render(80, 8, PLAIN).join("\n")).toContain("working");
  const readsAfterFirstRender = contentReads;
  harness.view.render(80, 8, PLAIN);
  expect(contentReads).toBe(readsAfterFirstRender);

  const updated = assistantMessage("working now", 2, "response-2");
  harness.emit({
    type: "message_update",
    message: updated,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " now", partial: updated } as AssistantMessageEvent,
  });
  const afterDelta = harness.messages();
  expect(afterDelta).not.toBe(first);
  expect(harness.messages()).toBe(afterDelta);
  harness.view.dispose();
});

test("live assistant handoff prefers response id then falls back to timestamp", () => {
  const sessionPath = join(mkdtempSync(join(tmpdir(), "nav-live-handoff-")), "child.jsonl");
  const persisted = assistantMessage("persisted", 10, "shared-response");
  writeFileSync(sessionPath, `${JSON.stringify({ type: "message", message: persisted })}\n`);
  const harness = liveTranscriptHarness(sessionPath);

  harness.setCurrent(assistantMessage("same identity", 10, "shared-response"));
  expect(harness.messages().map((message) => message.content)).toEqual([persisted.content]);

  harness.setCurrent(assistantMessage("new response", 10, "next-response"));
  expect(harness.messages()).toHaveLength(2);

  // A distinct id-less response sharing the persisted timestamp stays visible.
  harness.setCurrent(assistantMessage("same timestamp without response id", 10));
  expect(harness.messages()).toHaveLength(2);
  harness.setCurrent(assistantMessage("older timestamp", 9));
  expect(harness.messages()).toHaveLength(1);
  harness.setCurrent(assistantMessage("new timestamp", 11));
  expect(harness.messages()).toHaveLength(2);

  harness.setStatus("completed");
  expect(harness.messages()).toHaveLength(1);
  harness.view.dispose();
});

test("an id-less assistant crossing the persistence boundary renders exactly once", () => {
  const sessionPath = join(mkdtempSync(join(tmpdir(), "nav-live-equal-timestamp-")), "child.jsonl");
  const prompt = { role: "user", content: "prompt" };
  const persisted = assistantMessage("boundary message", 10);
  writeFileSync(sessionPath, `${JSON.stringify({ type: "message", message: prompt })}\n`);
  const harness = liveTranscriptHarness(sessionPath);

  // The live snapshot alone renders the message.
  harness.setCurrent(assistantMessage("boundary message", 10));
  expect(harness.messages()).toHaveLength(2);
  expect(harness.view.render(80, 8, PLAIN).join("\n")).toContain("boundary message");

  // The same message lands in the session file while the live snapshot still
  // holds it: equal id-less timestamps must not duplicate the entry.
  writeFileSync(sessionPath, [
    `${JSON.stringify({ type: "message", message: prompt })}\n`,
    `${JSON.stringify({ type: "message", message: persisted })}\n`,
  ].join(""));
  expect(harness.messages()).toHaveLength(2);
  expect(harness.view.render(80, 8, PLAIN).join("\n")).toContain("boundary message");
  harness.view.dispose();
});

test("one render burst performs at most one persisted detail read", async () => {
  const sessionPath = join(mkdtempSync(join(tmpdir(), "nav-detail-reads-")), "child.jsonl");
  writeFileSync(sessionPath, `${JSON.stringify({ type: "message", message: { role: "assistant", content: "done" } })}\n`);
  let detailReads = 0;
  const runner = { liveSession: () => undefined, get: () => undefined } as unknown as NavigatorRunner;
  const model = {
    detail: () => {
      detailReads += 1;
      return {
        runId: "run-1", runDir: "/run-1", kind: "subagent", label: "run", status: "completed",
        phases: [], narrator: [], hasScript: false, corrupt: false,
        children: [{ id: "child-1", label: "child", model: "test", status: "completed", tokens: 0, sessionFile: sessionPath, spec: { prompt: "work" } }],
      };
    },
  } as unknown as NavigatorModel;
  const view = buildAgentView(runner, { requestRender: () => {} } as unknown as TUI, model, "run-1", "child-1", undefined, {
    onMessage: () => true,
  });

  // Header, live-state, eligibility, and transcript reads within one
  // synchronous render burst share a single detail read.
  view.render(80, 8, PLAIN);
  expect(view.canSteer).toBe(false);
  expect(view.canMessage).toBe(true);
  expect(detailReads).toBe(1);

  // A later frame (after the microtask boundary) reads fresh detail.
  await Promise.resolve();
  view.render(80, 8, PLAIN);
  expect(detailReads).toBe(2);
});

test("navigator session-file stat gate preserves array identity until the file changes", () => {
  const sessionPath = join(mkdtempSync(join(tmpdir(), "nav-agent-cache-")), "child.jsonl");
  writeFileSync(sessionPath, `${JSON.stringify({ type: "message", message: { role: "assistant", content: "first" } })}\n`);
  const runner = {
    liveSession: () => undefined,
    get: () => undefined,
  } as unknown as NavigatorRunner;
  const model = {
    detail: () => ({
      runId: "run-1", runDir: "/run-1", kind: "subagent", label: "run", status: "completed",
      phases: [], narrator: [], hasScript: false, corrupt: false,
      children: [{ id: "child-1", label: "child", model: "test", status: "completed", tokens: 0, sessionFile: sessionPath, spec: { prompt: "work" } }],
    }),
  } as unknown as NavigatorModel;
  const view = buildAgentView(runner, { requestRender: () => {} } as unknown as TUI, model, "run-1", "child-1");
  const readMessages = (view as unknown as { deps: { messages: () => TranscriptMessage[] } }).deps.messages;

  const first = readMessages();
  expect(readMessages()).toBe(first);

  appendFileSync(sessionPath, `${JSON.stringify({ type: "message", message: { role: "assistant", content: "second" } })}\n`);
  const changed = readMessages();
  expect(changed).not.toBe(first);
  expect(changed.map((message) => message.content)).toEqual(["first", "second"]);
});

test("a rejected navigator steer is caught and surfaced", async () => {
  const errors: string[] = [];
  const handle = {
    status: "pending",
    steer: async () => { throw new Error("steer failed"); },
    abort: async () => {},
  } as unknown as SubagentHandle;
  const runner = {
    liveSession: () => undefined,
    get: () => handle,
  } as unknown as NavigatorRunner;
  const model = {
    detail: () => ({
      runId: "run-1", runDir: "/run-1", kind: "subagent", label: "run", status: "running",
      phases: [], narrator: [], hasScript: false, corrupt: false,
      children: [{ id: "child-1", label: "child", model: "test", status: "pending", tokens: 0, spec: { prompt: "work" } }],
    }),
  } as unknown as NavigatorModel;
  const view = buildAgentView(
    runner,
    { requestRender: () => {} } as unknown as TUI,
    model,
    "run-1",
    "child-1",
    (message) => errors.push(message),
  );

  expect(view.handleInput("", "enter")).toBe(true);
  view.handleInput("try steer", undefined);
  view.handleInput("\r", "return");
  await Promise.resolve();
  await Promise.resolve();
  expect(errors).toEqual(["Could not steer agent child-1: steer failed"]);
  view.dispose();
});

test("save refusal messages distinguish failed, quarantined, and non-workflow runs", () => {
  const detail: RunDetail = {
    runId: "run-1", runDir: "/run-1", kind: "workflow", label: "flow", status: "failed",
    phases: [], children: [], narrator: [], hasScript: true, corrupt: false,
  };

  expect(saveRefusalMessage(detail)).toBe("Workflow run run-1 did not complete successfully and cannot be saved");
  expect(saveRefusalMessage({ ...detail, kind: "subagent" })).toBe("Run run-1 is not a workflow and cannot be saved");
  expect(saveRefusalMessage({ ...detail, kind: "subagent", label: "quarantined - crashed mid-resume", corrupt: true }))
    .toBe("Workflow run run-1 is quarantined after a crashed generation commit and cannot be saved");
});

function pagingView(): { view: AgentView; renders: () => number } {
  let renderRequests = 0;
  const messages: TranscriptMessage[] = [{
    role: "assistant",
    content: Array.from({ length: 30 }, (_, index) => `transcript line ${index}`).join("\n"),
  }];
  const view = new AgentView({
    tui: { requestRender: () => { renderRequests += 1; } } as unknown as TUI,
    header: () => ({ label: "child", model: "test", status: "completed", tokens: 0 }),
    messages: () => messages,
    live: () => false,
  });
  view.render(80, 6, PLAIN);
  return { view, renders: () => renderRequests };
}

test("shift+up and shift+down page the agent transcript like PageUp and PageDown", () => {
  const shifted = pagingView();
  const paged = pagingView();

  expect(shifted.view.handleInput("\u001b[1;2A", parseKey("\u001b[1;2A")?.toLowerCase())).toBe(true);
  expect(paged.view.handleInput("", "pageup")).toBe(true);
  expect(shifted.view.render(80, 6, PLAIN)).toEqual(paged.view.render(80, 6, PLAIN));

  expect(shifted.view.handleInput("\u001b[1;2B", parseKey("\u001b[1;2B")?.toLowerCase())).toBe(true);
  expect(paged.view.handleInput("", "pagedown")).toBe(true);
  expect(shifted.view.render(80, 6, PLAIN)).toEqual(paged.view.render(80, 6, PLAIN));
  expect(shifted.renders()).toBe(2);
  expect(paged.renders()).toBe(2);
});
