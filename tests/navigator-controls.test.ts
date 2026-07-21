import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { encodeCwd } from "../src/store/run-store.js";
import { PLAIN } from "../src/ui/format.js";
import { cycleFilter, FILTERS, footerHint, keyToAction, orderedChildren, passesFilter, runActionAvailability, type FilterMode } from "../src/ui/navigator/controls.js";
import type { ChildRow, RunDetail } from "../src/ui/navigator/store-read.js";
import { NavigatorModel, NavigatorState } from "../src/ui/navigator/model.js";
import { registerNavigator, type NavigatorRunner } from "../src/ui/navigator/navigator.js";
import type { RunSummary } from "../src/ui/navigator/store-read.js";

test("filter cycles through all four buckets and wraps", () => {
  let filter: FilterMode = "all";
  const seen: FilterMode[] = [filter];
  for (let i = 0; i < FILTERS.length; i += 1) {
    filter = cycleFilter(filter);
    seen.push(filter);
  }
  expect(seen).toEqual(["all", "running", "completed", "failed", "all"]);
});

test("passesFilter buckets pending with running and aborted with failed", () => {
  expect(passesFilter("pending", "running")).toBe(true);
  expect(passesFilter("running", "running")).toBe(true);
  expect(passesFilter("aborted", "failed")).toBe(true);
  expect(passesFilter("completed", "failed")).toBe(false);
  expect(passesFilter("failed", "all")).toBe(true);
});

test("keyToAction maps keys per level; f only filters at run level; only enter steers at agent", () => {
  expect(keyToAction("up", "runs")).toEqual({ type: "move", delta: -1 });
  expect(keyToAction("j", "runs")).toEqual({ type: "move", delta: 1 });
  expect(keyToAction("pageup", "runs")).toEqual({ type: "pageMove", delta: -1 });
  expect(keyToAction("pagedown", "run")).toEqual({ type: "pageMove", delta: 1 });
  for (const level of ["runs", "run", "agent"] as const) {
    expect(keyToAction("tab", level)).toEqual({ type: "cycleLive", delta: 1 });
    expect(keyToAction("shift+tab", level)).toEqual({ type: "cycleLive", delta: -1 });
  }
  expect(keyToAction("shift+up", "runs")).toEqual({ type: "none" });
  expect(keyToAction("shift+down", "run")).toEqual({ type: "none" });
  expect(keyToAction("enter", "runs")).toEqual({ type: "drill" });
  expect(keyToAction("enter", "agent")).toEqual({ type: "steer" });
  expect(keyToAction("right", "runs")).toEqual({ type: "drill" });
  expect(keyToAction("right", "run")).toEqual({ type: "drill" });
  expect(keyToAction("right", "agent")).toEqual({ type: "none" });
  expect(keyToAction("escape", "run")).toEqual({ type: "back" });
  expect(keyToAction("x", "run")).toEqual({ type: "stop" });
  expect(keyToAction("b", "runs")).toEqual({ type: "background" });
  expect(keyToAction("b", "run")).toEqual({ type: "background" });
  expect(keyToAction("b", "agent")).toEqual({ type: "none" });
  expect(keyToAction("r", "runs")).toEqual({ type: "none" });
  expect(keyToAction("r", "run")).toEqual({ type: "none" });
  expect(keyToAction("f", "run")).toEqual({ type: "filter" });
  expect(keyToAction("f", "runs")).toEqual({ type: "none" });
  expect(keyToAction("s", "run")).toEqual({ type: "save" });
  // Pause is deliberately unmapped - no runner pause seam exists.
  expect(keyToAction("p", "run")).toEqual({ type: "none" });
});

function runSummary(runId: string): RunSummary {
  return {
    runId, runDir: `/runs/${runId}`, kind: "subagent", createdAt: 0, label: runId,
    fanout: false, status: "completed", done: 1, total: 1, completed: 1, failed: 0, aborted: 0, tokens: 0,
    corrupt: false, reconciled: false,
  };
}

test("run-list selection follows run identity across live reordering", () => {
  const state = new NavigatorState();
  const original = [runSummary("a"), runSummary("b"), runSummary("c")];
  state.reconcileRuns(original);
  state.moveRun(1, original);
  expect(state.currentRunId(original)).toBe("b");

  const reordered = [runSummary("c"), runSummary("a"), runSummary("b")];
  state.reconcileRuns(reordered);
  expect(state.currentRunId(reordered)).toBe("b");
  expect(state.cursor).toBe(2);
});

test("seedRun opens run detail with normal back navigation", () => {
  const state = new NavigatorState();
  const runs = [runSummary("a"), runSummary("b")];

  state.seedRun("b");
  expect(state.level).toBe("run");
  expect(state.depth).toBe(2);
  expect(state.runId).toBe("b");
  expect(state.back()).toBe(true);
  expect(state.level).toBe("runs");
  expect(state.currentRunId(runs)).toBe("b");
});

function childRow(id: string, startedAt?: number): ChildRow {
  return {
    id, label: id, model: "test/tiny", status: startedAt === undefined ? "pending" : "running",
    tokens: 0, startedAt, spec: { prompt: id },
  };
}

test("run-detail selection follows child identity across live reordering", () => {
  const state = new NavigatorState();
  // Enter the run level via a drill on a single-run model.
  const detailOf = (children: ChildRow[]) => ({
    runId: "workflow-x", kind: "workflow", status: "running", phases: [],
    children, narrator: [], corrupt: false, hasScript: true,
  }) as unknown as RunDetail;
  let children = [childRow("child-a", 10), childRow("child-b", 20), childRow("child-c", 30)];
  const model = {
    runs: () => [{ ...runSummary("workflow-x"), kind: "workflow", status: "running" }],
    detail: () => detailOf(children),
  } as unknown as NavigatorModel;
  expect(state.drill(model)).toBe("run");

  state.moveChild(1, orderedChildren(model.detail("workflow-x"), "all"));
  expect(state.cursor).toBe(1);

  // child-c's real start time lands earlier than the others and it re-sorts
  // to the top; the selection must stay on child-b, not on index 1.
  children = [childRow("child-a", 10), childRow("child-b", 20), childRow("child-c", 5)];
  const reordered = orderedChildren(model.detail("workflow-x"), "all");
  expect(reordered.map((child) => child.id)).toEqual(["child-c", "child-a", "child-b"]);
  state.reconcileChildren(reordered);
  expect(reordered[state.cursor]!.id).toBe("child-b");

  // Enter opens the agent the user sees selected, not the stale index.
  expect(state.drill(model)).toBe("agent");
  expect(state.childId).toBe("child-b");
});

test("switchRun replaces drilled context and clears the selected child", () => {
  const details = new Map<string, RunDetail>([
    ["run-a", {
      runId: "run-a", runDir: "/run-a", kind: "subagent", label: "a", status: "running",
      phases: [], children: [childRow("child-a", 1)], narrator: [], hasScript: false, corrupt: false,
    }],
    ["run-b", {
      runId: "run-b", runDir: "/run-b", kind: "subagent", label: "b", status: "running",
      phases: [], children: [childRow("child-b", 2)], narrator: [], hasScript: false, corrupt: false,
    }],
  ]);
  const model = {
    runs: () => [runSummary("run-a"), runSummary("run-b")],
    detail: (runId: string) => details.get(runId)!,
  } as unknown as NavigatorModel;
  const state = new NavigatorState();
  state.seedRun("run-a");
  expect(state.drill(model)).toBe("agent");
  expect(state.childId).toBe("child-a");

  state.switchRun("run-b");
  expect(state.level).toBe("run");
  expect(state.depth).toBe(2);
  expect(state.runId).toBe("run-b");
  expect(state.childId).toBeUndefined();
  expect(state.cursor).toBe(0);
  expect(state.drill(model)).toBe("agent");
  expect(state.childId).toBe("child-b");
});

test("page movement advances by a viewport and clamps at the ends", () => {
  const state = new NavigatorState();
  const runs = Array.from({ length: 20 }, (_, index) => runSummary(String(index)));
  state.pageMoveRun(1, runs, 7);
  expect(state.cursor).toBe(7);
  state.pageMoveRun(1, runs, 50);
  expect(state.cursor).toBe(19);
  state.pageMoveRun(-1, runs, 5);
  expect(state.cursor).toBe(14);
});

test("quarantined runs drill into recovery detail while unreadable runs stay closed", () => {
  const quarantined = {
    ...runSummary("quarantined"),
    label: "quarantined - crashed mid-resume",
    corrupt: true,
  };
  const unreadable = { ...runSummary("unreadable"), label: "unreadable run", corrupt: true };
  const model = { runs: () => [quarantined, unreadable] } as NavigatorModel;
  const state = new NavigatorState();

  expect(state.drill(model)).toBe("run");
  expect(state.runId).toBe("quarantined");
  expect(state.back()).toBe(true);
  state.moveRun(1, model.runs());
  expect(state.drill(model)).toBeUndefined();
});

test("footerHint composes per level and never advertises pause", () => {
  const runs = footerHint({ level: "runs" }, PLAIN);
  expect(runs).toContain("enter open");
  expect(runs).not.toContain("x stop");
  expect(runs).not.toContain("b background");
  expect(runs).not.toContain("s save");
  expect(runs).not.toContain("tab next live");
  const liveRuns = footerHint({ level: "runs", canCycle: true, canStop: true, canBackground: true, canSave: true }, PLAIN);
  expect(liveRuns).toContain("x stop");
  expect(liveRuns).toContain("b background");
  expect(liveRuns).toContain("s save");
  expect(liveRuns).toContain("tab next live");
  expect(footerHint({ level: "runs", canStop: true, stopArmed: true }, PLAIN)).toContain("x again to STOP");
  expect(runs).not.toContain("restart");
  expect(runs).not.toContain("pause");

  const run = footerHint({ level: "run", filter: "failed" }, PLAIN);
  expect(run).toContain("f filter: failed");
  expect(run).not.toContain("b background");
  expect(run).not.toContain("tab next live");
  expect(footerHint({ level: "run", filter: "all", canCycle: true }, PLAIN)).toContain("tab next live");
  expect(footerHint({ level: "run", filter: "all", canBackground: true }, PLAIN)).toContain("b background");
  expect(footerHint({ level: "run", filter: "all", canStop: true, stopArmed: true }, PLAIN)).toContain("x again to STOP");
  expect(run).not.toContain("restart");

  const agentArmed = footerHint({ level: "agent", canSteer: true, canStop: true, stopArmed: true }, PLAIN);
  expect(agentArmed).toContain("enter steer");
  expect(agentArmed).toContain("shift+↑↓ page");
  expect(agentArmed).toContain("x again to STOP");
  expect(agentArmed).not.toContain("restart");
  const staticAgent = footerHint({ level: "agent", canCycle: true, canSteer: false, canStop: false }, PLAIN);
  expect(staticAgent).not.toContain("steer");
  expect(staticAgent).not.toContain("x stop");
  expect(staticAgent).toContain("tab next live");
  expect(footerHint({ level: "agent", canCycle: false, canSteer: false, canStop: false }, PLAIN)).not.toContain("tab next live");
});

test("run-detail footer only advertises actions available for the run", () => {
  const terminalSubagent: RunDetail = {
    runId: "subagent-terminal", runDir: "/subagent-terminal", kind: "subagent", label: "done", status: "completed",
    phases: [], children: [], narrator: [], hasScript: false, corrupt: false,
  };
  const terminalActions = runActionAvailability(terminalSubagent, false, ["completed"], false, true);
  const terminalFooter = footerHint({ level: "run", ...terminalActions }, PLAIN);
  expect(terminalFooter).not.toContain("x stop");
  expect(terminalFooter).not.toContain("s save");

  const runningWorkflow: RunDetail = {
    ...terminalSubagent,
    runId: "workflow-running",
    kind: "workflow",
    status: "running",
    hasScript: true,
  };
  const runningActions = runActionAvailability(runningWorkflow, true, [], true, true);
  const runningFooter = footerHint({ level: "run", ...runningActions }, PLAIN);
  expect(runningActions.canBackground).toBe(true);
  expect(runningFooter).toContain("x stop");
  expect(runningFooter).toContain("b background");
  expect(runningFooter).not.toContain("s save");

  const completedWorkflow: RunDetail = {
    ...runningWorkflow,
    runId: "workflow-completed",
    status: "completed",
  };
  const completedActions = runActionAvailability(completedWorkflow, false, ["completed"], false, true);
  const completedFooter = footerHint({ level: "run", ...completedActions }, PLAIN);
  expect(completedFooter).not.toContain("x stop");
  expect(completedFooter).toContain("s save");
});

function child(id: string, phase: string | undefined, status: ChildRow["status"], startedAt: number): ChildRow {
  return { id, label: id, model: "", phase, status, tokens: 0, startedAt, spec: { prompt: id } };
}

test("orderedChildren groups workflow children by phase order then start, and filters", () => {
  const detail: RunDetail = {
    runId: "w", runDir: "/w", kind: "workflow", label: "w", status: "running",
    phases: [{ title: "plan" }, { title: "build" }],
    children: [
      child("b1", "build", "running", 20),
      child("p2", "plan", "completed", 15),
      child("p1", "plan", "completed", 10),
    ],
    narrator: [], hasScript: false, corrupt: false,
  };
  expect(orderedChildren(detail, "all").map((c) => c.id)).toEqual(["p1", "p2", "b1"]);
  expect(orderedChildren(detail, "completed").map((c) => c.id)).toEqual(["p1", "p2"]);
});

test("orderedChildren keeps spawn order for subagent runs", () => {
  const detail: RunDetail = {
    runId: "s", runDir: "/s", kind: "subagent", label: "s", status: "running",
    phases: [],
    children: [child("x2", undefined, "running", 5), child("x1", undefined, "completed", 1)],
    narrator: [], hasScript: false, corrupt: false,
  };
  expect(orderedChildren(detail, "all").map((c) => c.id)).toEqual(["x2", "x1"]);
});

function writeNavigatorRun(root: string, cwd: string, runId: string, createdAt: string): void {
  const runDir = join(root, encodeCwd(cwd), runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    v: 3,
    runId,
    kind: "subagent",
    createdAt,
    parent: { sessionId: "session-current" },
    children: [],
  }));
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ status: "running", children: {} }));
  writeFileSync(join(runDir, "events.jsonl"), "");
}

function fakeNavigatorRunner(liveRunIds: () => string[]): NavigatorRunner {
  return {
    liveRunIds,
    runHandles: () => [],
    liveSession: () => undefined,
    get: () => undefined,
    stopRun: async () => {},
    waitedRunIds: () => [],
    detachWaitedRun: () => false,
    subscribeSpawns: () => () => {},
  };
}

function fakeNavigatorPi(): ExtensionAPI {
  return {
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
}

test("navigator lands on the only live run detail", async () => {
  const cwd = "/navigator/smart-landing";
  const root = mkdtempSync(join(tmpdir(), "navigator-smart-landing-"));
  writeNavigatorRun(root, cwd, "run-only", "2026-07-15T02:00:00.000Z");
  const open = registerNavigator(fakeNavigatorPi(), { runner: fakeNavigatorRunner(() => ["run-only"]), root });
  let rendered: string[] = [];

  try {
    await open({
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "session-current" },
      ui: {
        custom: async (factory: (...args: any[]) => any) => {
          const component = factory(
            { requestRender: () => {}, terminal: { rows: 24 } },
            PLAIN,
            {},
            () => {},
          );
          rendered = component.render(100);
          component.dispose?.();
        },
        notify: () => {},
      },
    } as unknown as Parameters<typeof open>[0]);

    expect(rendered.join("\n")).toContain("run-only");
    expect(rendered.join("\n")).toContain("f filter: all");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live run in another cwd does not defeat smart landing", async () => {
  const cwd = "/navigator/smart-landing-cross-cwd";
  const root = mkdtempSync(join(tmpdir(), "navigator-smart-landing-cross-"));
  writeNavigatorRun(root, cwd, "run-visible", "2026-07-15T02:00:00.000Z");
  // The runner is process-global: it also reports a live run persisted under a
  // different cwd, which the navigator model for this cwd cannot see.
  const open = registerNavigator(fakeNavigatorPi(), { runner: fakeNavigatorRunner(() => ["run-elsewhere", "run-visible"]), root });
  let rendered: string[] = [];

  try {
    await open({
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "session-current" },
      ui: {
        custom: async (factory: (...args: any[]) => any) => {
          const component = factory(
            { requestRender: () => {}, terminal: { rows: 24 } },
            PLAIN,
            {},
            () => {},
          );
          rendered = component.render(100);
          component.dispose?.();
        },
        notify: () => {},
      },
    } as unknown as Parameters<typeof open>[0]);

    expect(rendered.join("\n")).toContain("run-visible");
    expect(rendered.join("\n")).toContain("f filter: all");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tab cycles from one live run detail to the next", async () => {
  const cwd = "/navigator/live-cycle";
  const root = mkdtempSync(join(tmpdir(), "navigator-live-cycle-"));
  writeNavigatorRun(root, cwd, "run-new", "2026-07-15T02:00:00.000Z");
  writeNavigatorRun(root, cwd, "run-old", "2026-07-15T01:00:00.000Z");
  const open = registerNavigator(fakeNavigatorPi(), { runner: fakeNavigatorRunner(() => ["run-old", "run-new"]), root });
  let firstDetail = "";
  let secondDetail = "";

  try {
    await open({
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "session-current" },
      ui: {
        custom: async (factory: (...args: any[]) => any) => {
          const component = factory(
            { requestRender: () => {}, terminal: { rows: 24 } },
            PLAIN,
            {},
            () => {},
          );
          component.render(100);
          component.handleInput("\r");
          firstDetail = component.render(100).join("\n");
          component.handleInput("\t");
          secondDetail = component.render(100).join("\n");
          component.dispose?.();
        },
        notify: () => {},
      },
    } as unknown as Parameters<typeof open>[0]);

    expect(firstDetail).toContain("run-new");
    expect(firstDetail).toContain("tab next live");
    expect(secondDetail).toContain("run-old");
    expect(secondDetail).not.toContain("run-new");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stopping a run is confirmed inside the navigator with a second x press", async () => {
  const cwd = "/navigator/stop-confirmation";
  const root = mkdtempSync(join(tmpdir(), "navigator-stop-confirmation-"));
  writeNavigatorRun(root, cwd, "run-live", "2026-07-15T02:00:00.000Z");
  const stopped: string[] = [];
  const runner = {
    ...fakeNavigatorRunner(() => ["run-live"]),
    stopRun: async (runId: string) => { stopped.push(runId); },
  };
  const open = registerNavigator(fakeNavigatorPi(), { runner, root });
  let armed = "";
  let afterStop = "";

  try {
    await open({
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "session-current" },
      ui: {
        custom: async (factory: (...args: any[]) => any) => {
          const component = factory(
            { requestRender: () => {}, terminal: { rows: 24 } },
            PLAIN,
            {},
            () => {},
          );
          component.handleInput("x");
          armed = component.render(100).join("\n");
          component.handleInput("x");
          await Promise.resolve();
          await Promise.resolve();
          afterStop = component.render(100).join("\n");
          component.dispose?.();
        },
        notify: () => {},
      },
    } as unknown as Parameters<typeof open>[0]);

    expect(armed).toContain("x again to STOP");
    expect(stopped).toEqual(["run-live"]);
    expect(afterStop).not.toContain("x again to STOP");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("navigator open is reentrant-safe and releases its guard after close", async () => {
  const open = registerNavigator(fakeNavigatorPi(), { runner: fakeNavigatorRunner(() => []) });
  let customCalls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const ctx = {
    cwd: "/navigator/reentrant",
    hasUI: true,
    sessionManager: { getSessionId: () => "session-current" },
    ui: {
      custom: () => {
        customCalls += 1;
        return customCalls === 1 ? blocked : Promise.resolve();
      },
    },
  } as unknown as Parameters<typeof open>[0];

  const first = open(ctx);
  await Promise.resolve();
  await open(ctx);
  expect(customCalls).toBe(1);

  release();
  await first;
  await open(ctx);
  expect(customCalls).toBe(2);
});

test("navigator cannot background another session's waited run", async () => {
  const cwd = "/navigator/session-scope";
  const root = mkdtempSync(join(tmpdir(), "navigator-session-scope-"));
  const runDir = join(root, encodeCwd(cwd), "run-other");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({
    v: 3,
    runId: "run-other",
    kind: "subagent",
    createdAt: "2026-07-15T00:00:00.000Z",
    parent: { sessionId: "session-other" },
    children: [],
  }));
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ status: "completed", children: {} }));
  writeFileSync(join(runDir, "events.jsonl"), "");

  const waitedCalls: string[] = [];
  const detachCalls: Array<[string, string]> = [];
  const runner = {
    liveRunIds: () => [],
    runHandles: () => [],
    liveSession: () => undefined,
    get: () => undefined,
    stopRun: async () => {},
    waitedRunIds: (parentSessionId: string) => {
      waitedCalls.push(parentSessionId);
      return parentSessionId === "session-other" ? ["run-other"] : [];
    },
    detachWaitedRun: (runId: string, parentSessionId: string) => {
      detachCalls.push([runId, parentSessionId]);
      return runId === "run-other" && parentSessionId === "session-other";
    },
    subscribeSpawns: () => () => {},
  } as unknown as NavigatorRunner;
  let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  const pi = {
    registerCommand: (name: string, registered: typeof command) => {
      if (name === "agents") command = registered;
    },
  } as unknown as ExtensionAPI;
  const notifications: string[] = [];
  let rendered: string[] = [];
  registerNavigator(pi, { runner, root });

  try {
    await command!.handler("", {
      cwd,
      hasUI: true,
      sessionManager: { getSessionId: () => "session-current" },
      ui: {
        custom: async (factory: (...args: any[]) => any) => {
          const component = factory(
            { requestRender: () => {}, terminal: { rows: 24 } },
            PLAIN,
            {},
            () => {},
          );
          rendered = component.render(100);
          component.handleInput("b");
          component.dispose?.();
        },
        notify: (message: string) => { notifications.push(message); },
      },
    });

    expect(rendered.join("\n")).not.toContain("b background");
    expect(waitedCalls).toEqual(["session-current"]);
    expect(detachCalls).toEqual([["run-other", "session-current"]]);
    expect(notifications).toContain("Run is not blocking a waited tool call");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
