import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKey, type TUI } from "@earendil-works/pi-tui";
import type { ChildSession } from "../src/runner/child-session.js";
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
