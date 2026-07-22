import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  catchUpUndeliveredRuns,
  createNavigatorFollowUp,
} from "../extensions/subagent-workflow.js";
import { FOLLOW_UP_PROMPT_PREFIX } from "../src/ui/navigator/transcript.js";
import type { ParentContext, ResolvedFollowUpSpec } from "../src/runner/child.js";
import type { SubagentRunner } from "../src/runner/runner.js";
import { releasePendingDeliveries } from "../src/store/delivery-marker.js";
import { RunStore } from "../src/store/run-store.js";
import { writeSessionClosedMarker } from "../src/store/session-closed-marker.js";
import { resolveFollowUpSpec } from "../src/tool/subagent-tool.js";
import { isMessageableChild } from "../src/ui/navigator/navigator.js";
import type { ChildRow } from "../src/ui/navigator/store-read.js";
import type { SubagentStatusWidget } from "../src/ui/status-widget.js";
import type { ResolvedSpec, SubagentHandle, SubagentResult, SubagentSpec, SubagentStatus } from "../src/types.js";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
const resolved: ResolvedSpec = {
  provider: "test",
  modelId: "tiny",
  thinkingLevel: "off",
  tools: [],
  cwd: "/tmp",
  label: "source child",
};

function persistedChild(options: {
  root: string;
  cwd: string;
  runId: string;
  childId: string;
  status: SubagentStatus;
  spec?: SubagentSpec;
  keepOwned?: boolean;
}): RunStore {
  const store = new RunStore(options.runId, options.cwd, "source-parent", undefined, { rootDir: options.root });
  const spec = options.spec ?? { prompt: "original" };
  const sessionFile = join(store.sessionsDir, `${options.childId}.jsonl`);
  mkdirSync(store.sessionsDir, { recursive: true });
  writeFileSync(sessionFile, "original transcript\n");
  store.addChild(options.childId, spec);
  store.resolveChild(options.childId, { ...resolved, cwd: options.cwd }, sessionFile);
  store.recordEvent({ type: "status", id: options.childId, status: options.status });
  if (options.status !== "running" && options.status !== "pending") {
    writeSessionClosedMarker(store.runDir, options.childId);
  }
  if (!options.keepOwned) store.releaseOwnership();
  return store;
}

function navigatorContext(cwd: string, sessionId = "parent"): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

test("navigator follow-up resolves the qualified child, preflights, spawns, and fences delivery", async () => {
  const root = mkdtempSync(join(tmpdir(), "navigator-follow-up-service-"));
  const cwd = "/work/navigator-follow-up-service";
  const sourceStore = persistedChild({ root, cwd, runId: "run-source", childId: "child-source", status: "completed" });
  const sourceSessionFile = join(sourceStore.sessionsDir, "child-source.jsonl");
  const order: string[] = [];
  const resolvedIds: string[] = [];
  const spawned: ResolvedFollowUpSpec[] = [];
  const marked: string[] = [];
  const delivered: string[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  let targetStore: RunStore | undefined;
  const targetChildId = "child-follow-up";
  const targetRunId = "run-follow-up";

  const pi = {
    getThinkingLevel: () => "high",
    appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
    sendUserMessage: (message: string) => { delivered.push(message); },
  } as unknown as ExtensionAPI;
  const runner = {
    spawnRun: (specs: ResolvedFollowUpSpec[], parent: ParentContext, options?: { directDelivery?: boolean }) => {
      order.push("spawn");
      expect(parent.thinkingLevel).toBe("high");
      expect(options?.directDelivery).toBe(true);
      spawned.push(...specs);
      targetStore = new RunStore(targetRunId, cwd, "parent", undefined, { rootDir: root, directDelivery: true });
      targetStore.addChild(targetChildId, specs[0]!.spec, specs[0]!.followUpOf);
      const sessionFile = join(targetStore.sessionsDir, `${targetChildId}.jsonl`);
      writeFileSync(sessionFile, "follow-up transcript\n");
      targetStore.resolveChild(targetChildId, { ...resolved, label: "follow-up child", cwd }, sessionFile);
      targetStore.recordEvent({ type: "status", id: targetChildId, status: "completed" });
      writeSessionClosedMarker(targetStore.runDir, targetChildId);
      const result: SubagentResult = {
        id: targetChildId,
        generation: 1,
        status: "completed",
        sessionFile,
        text: "follow-up complete",
        usage,
        resolved: { ...resolved, label: "follow-up child", cwd },
      };
      const handle: SubagentHandle = {
        id: targetChildId,
        runId: targetRunId,
        runDir: targetStore.runDir,
        generation: 1,
        spec: specs[0]!.spec,
        resolved: result.resolved,
        status: "completed",
        startedAt: Date.now(),
        result: Promise.resolve(result),
        abort: async () => {},
        steer: async () => {},
        subscribe: () => () => {},
      };
      return [handle];
    },
    markDelivered: (runId: string) => {
      marked.push(runId);
      targetStore?.releaseOwnership();
      return undefined;
    },
  } as unknown as SubagentRunner;
  const service = createNavigatorFollowUp(pi, "/extension.ts", {
    runner,
    runsRoot: root,
    resolveFollowUp: (id, prompt, sourceCwd) => {
      resolvedIds.push(id);
      return resolveFollowUpSpec(id, prompt, sourceCwd, root);
    },
    preflight: (spec, _parent, overrides) => {
      order.push("preflight");
      expect(spec.prompt).toBe(`${FOLLOW_UP_PROMPT_PREFIX}continue the analysis`);
      expect(overrides?.forkSessionFile).toBe(sourceSessionFile);
      return {} as never;
    },
  });

  try {
    const target = service.send("run-source", "child-source", "  continue the analysis  ", navigatorContext(cwd));
    expect(target).toEqual({ runId: targetRunId, childId: targetChildId });
    expect(resolvedIds).toEqual(["run-source/child-source"]);
    expect(order).toEqual(["preflight", "spawn"]);
    expect(spawned[0]!.followUpOf).toEqual({ runId: "run-source", childId: "child-source" });
    // The policy is part of the run record itself, durable from before the
    // child started: no crash window can leave the run catch-up eligible.
    expect(JSON.parse(readFileSync(join(targetStore!.runDir, "run.json"), "utf8")).directDelivery).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(marked).toEqual([targetRunId]);
    expect(delivered).toEqual([]);
    expect(entries.map((entry) => entry.type)).toContain("subagent-workflow:run-completed");
    const deliveredPath = join(targetStore!.runDir, "delivered.json");
    expect(JSON.parse(readFileSync(deliveredPath, "utf8"))).toEqual({
      v: 1,
      sessionId: "parent",
      catchUp: false,
      generation: 1,
    });
    expect(catchUpUndeliveredRuns(pi, navigatorContext(cwd), root)).toEqual([]);
  } finally {
    targetStore?.releaseOwnership();
    releasePendingDeliveries("parent");
    rmSync(root, { recursive: true, force: true });
  }
});

test("navigator follow-up validation refuses empty and slash-command prompts before resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "navigator-follow-up-validation-"));
  const calls: string[] = [];
  const service = createNavigatorFollowUp({ getThinkingLevel: () => "off" } as unknown as ExtensionAPI, "/extension.ts", {
    runsRoot: root,
    resolveFollowUp: (_id, prompt) => {
      calls.push(prompt);
      throw new Error("resolver should not run");
    },
    preflight: () => { throw new Error("preflight should not run"); },
    runner: { spawnRun: () => { throw new Error("spawn should not run"); } } as unknown as SubagentRunner,
  });
  const ctx = navigatorContext("/tmp");

  try {
    expect(() => service.send("run", "child", "   ", ctx)).toThrow("Follow-up message must not be empty");
    expect(() => service.send("run", "child", " /compact ", ctx)).toThrow("Slash commands are not supported");
    expect(calls).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("navigator follow-up reports a started run even when post-spawn widget tracking fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "navigator-follow-up-widget-fail-"));
  const missingRunDir = join(root, "missing", "run-follow-up");
  const marked: string[] = [];
  const result: SubagentResult = {
    id: "child-follow-up",
    generation: 1,
    status: "completed",
    sessionFile: join(root, "session.jsonl"),
    text: "follow-up complete",
    usage,
    resolved: { ...resolved, label: "follow-up child", cwd: "/tmp" },
  };
  const handle: SubagentHandle = {
    id: "child-follow-up",
    runId: "run-follow-up",
    runDir: missingRunDir,
    generation: 1,
    spec: { prompt: "continue" },
    resolved: result.resolved,
    status: "completed",
    startedAt: Date.now(),
    result: Promise.resolve(result),
    abort: async () => {},
    steer: async () => {},
    subscribe: () => () => {},
  };
  const runner = {
    spawnRun: () => [handle],
    markDelivered: (runId: string) => { marked.push(runId); return undefined; },
  } as unknown as SubagentRunner;
  const pi = {
    getThinkingLevel: () => "off",
    appendEntry: () => {},
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI;
  const service = createNavigatorFollowUp(pi, "/extension.ts", {
    runner,
    runsRoot: root,
    resolveFollowUp: () => ({
      spec: { prompt: "continue" },
      forkSessionFile: join(root, "session.jsonl"),
      followUpOf: { runId: "run-source", childId: "child-source" },
    }),
    preflight: () => ({} as never),
    widget: { track: () => { throw new Error("widget offline"); } } as unknown as SubagentStatusWidget,
  });

  try {
    let target: { runId: string; childId: string } | undefined;
    expect(() => { target = service.send("run-source", "child-source", "continue", navigatorContext("/work")); }).not.toThrow();
    expect(target).toEqual({ runId: "run-follow-up", childId: "child-follow-up" });
    // The completion finalizer was attached before the failing widget call, so
    // delivery is still marked instead of leaving the run catch-up eligible.
    await Promise.resolve();
    await Promise.resolve();
    expect(marked).toEqual(["run-follow-up"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("navigator follow-up surfaces resolver refusals before preflight or spawn", () => {
  let preflighted = false;
  let spawned = false;
  const service = createNavigatorFollowUp({ getThinkingLevel: () => "off" } as unknown as ExtensionAPI, "/extension.ts", {
    resolveFollowUp: () => { throw new Error("source session closure is not confirmed; wait and retry"); },
    preflight: () => { preflighted = true; return {} as never; },
    runner: { spawnRun: () => { spawned = true; return []; } } as unknown as SubagentRunner,
  });

  expect(() => service.send("run", "child", "continue", navigatorContext("/tmp")))
    .toThrow("source session closure is not confirmed; wait and retry");
  expect(preflighted).toBe(false);
  expect(spawned).toBe(false);
});

test("isMessageableChild accepts terminal persisted children and rejects live or worktree origins", () => {
  const row = (overrides: Partial<ChildRow>): ChildRow => ({
    id: "child",
    label: "child",
    model: "test",
    status: "completed",
    tokens: 0,
    sessionFile: "/runs/run/sessions/child.jsonl",
    spec: { prompt: "original" },
    ...overrides,
  });

  expect(isMessageableChild(undefined)).toBe(false);
  expect(isMessageableChild(row({ status: "running" }))).toBe(false);
  expect(isMessageableChild(row({ status: "pending" }))).toBe(false);
  expect(isMessageableChild(row({ sessionFile: undefined }))).toBe(false);
  expect(isMessageableChild(row({ spec: { prompt: "edit", isolation: "worktree" } }))).toBe(false);
  expect(isMessageableChild(row({ status: "completed" }))).toBe(true);
  expect(isMessageableChild(row({ status: "failed" }))).toBe(true);
  expect(isMessageableChild(row({ status: "aborted" }))).toBe(true);
});
