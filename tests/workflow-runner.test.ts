import { expect, spyOn, test } from "bun:test";
import type { ChildSession } from "../src/runner/child-session.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParentContext } from "../src/runner/child.js";
import { MAX_INLINE_WORKTREE_PATCH_BYTES } from "../src/runner/inline-patch.js";
import { SubagentRunner } from "../src/runner/runner.js";
import { acquireRunOwnership, OWNER_FILE } from "../src/store/lease.js";
import { encodeCwd, RunStore } from "../src/store/run-store.js";
import { probeSqliteLock } from "../src/store/sqlite-lock.js";
import type { ResolvedSpec, SubagentHandle, SubagentResult, SubagentSpec } from "../src/types.js";
import { readRunDetail } from "../src/ui/navigator/store-read.js";
import { JournalUnreadableError } from "../src/workflow/journal.js";
import { parseWorkflowScript } from "../src/workflow/parser.js";
import { formatWorkflowResult } from "../src/workflow/launch.js";
import { findLatestCompletedWorkflowRun, findWorkflowRunById, resolveRunDir } from "../src/workflow/saved.js";
import { WORKFLOW_AGENT_CAP, normalizeArgs, runWorkflow, startParsedWorkflow } from "../src/workflow/workflow-runner.js";

const parent = { ctx: { cwd: "/work", model: { provider: "test", id: "parent-model" }, sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent.jsonl" } }, thinkingLevel: "off", selfPath: "/extension.ts" } as unknown as ParentContext;

class FakeRunner {
  calls: SubagentSpec[] = [];
  delivered: string[] = [];
  controllers = new Map<string, AbortController>();
  registrations: Array<{ runId: string; parentSessionId?: string }> = [];
  stores = new Map<string, RunStore>();
  resultFactory?: (spec: SubagentSpec, number: number) => Promise<SubagentResult>;
  abortFactory?: (spec: SubagentSpec, number: number) => Promise<void>;
  /** When set, abort the run controller as soon as this many agents have spawned. */
  stopAfter = Number.POSITIVE_INFINITY;
  markDelivered(runId: string): void { this.delivered.push(runId); }
  registerRunController(runId: string, controller: AbortController, parentSessionId?: string, _execution?: Promise<unknown>): void {
    this.controllers.set(runId, controller);
    this.registrations.push({ runId, parentSessionId });
  }
  unregisterRunController(runId: string): void { this.controllers.delete(runId); }
  isRunActive(runId: string): boolean { return this.controllers.has(runId); }
  spawnRun(specs: SubagentSpec[], _parent: ParentContext, options: { runId: string; store: unknown }): SubagentHandle[] {
    const spec = specs[0]!;
    if (!(options.store instanceof RunStore)) throw new Error("workflow did not pass its RunStore to spawnRun");
    const store = options.store;
    const previousStore = this.stores.get(options.runId);
    if (previousStore && previousStore !== store) throw new Error("workflow changed RunStore instances within one run");
    this.stores.set(options.runId, store);
    this.calls.push(spec);
    const number = this.calls.length;
    const id = `child-${store.childCount + 1}`;
    store.addChild(id, spec);
    if (number >= this.stopAfter) this.controllers.get(options.runId)?.abort();
    const result = (this.resultFactory?.(spec, number) ?? Promise.resolve(fakeResult(spec, number))).then((value) => {
      const identified = { ...value, id };
      store.recordEvent({ type: "result", id, result: identified });
      return identified;
    });
    return [{ id, runId: options.runId, runDir: store.runDir, spec, resolved: undefined, status: "running", startedAt: 0, result, steer: async () => {}, abort: async () => await this.abortFactory?.(spec, number), subscribe: () => () => {} }];
  }
}

function fakeResult(spec: SubagentSpec, number: number, overrides: Partial<SubagentResult> = {}): SubagentResult {
  return {
    id: `child-${number}`,
    status: "completed",
    text: `result-${number}`,
    structured: spec.schema ? { value: number } : undefined,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    resolved: { provider: "test", modelId: "test", thinkingLevel: "off", tools: [], cwd: "/work", label: spec.label ?? "test" },
    ...overrides,
  };
}

test("raw-script parser failures remain Promise rejections", async () => {
  let execution!: Promise<unknown>;
  expect(() => {
    execution = runWorkflow({ script: "not valid JavaScript !!!" }, parent);
  }).not.toThrow();
  await expect(execution).rejects.toThrow("Workflow syntax error");
});

test("owned workflow projections include phases and narrator lines synchronously", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-live-projection-"));
  const runner = new SubagentRunner();
  let observed: ReturnType<SubagentRunner["runProjection"]>;
  const script = `export const meta = { name: 'live-projection', description: 'test', phases: [{ title: 'Plan' }, { title: 'Build' }] };
phase('Build');
log('building now');
return 1;`;

  await runWorkflow({ script }, parent, {
    rootDir,
    runner,
    onLog: () => { observed = runner.runProjection([...runner.liveRunIds()][0]!); },
  });

  expect(observed).toMatchObject({
    summary: { kind: "workflow", label: "live-projection", status: "running" },
    detail: {
      phases: [{ title: "Plan" }, { title: "Build" }],
      narrator: [
        { kind: "phase", text: "Build" },
        { kind: "log", text: "building now" },
      ],
    },
  });
});

test("workflow agent options use the direct runtime contract before replay or spawn", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-agent-options-"));
  const validScript = `export const meta = { name: 'option-validation', description: 'test' };
return agent('edit', { isolation: 'worktree' });`;
  const first = await runWorkflow({ script: validScript }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
  });
  const journalPath = join(first.runDir, "journal.jsonl");
  const journalBefore = readFileSync(journalPath, "utf8");

  const invalidIsolation = validScript.replace("'worktree'", "'work-tree'");
  const resumeRunner = new FakeRunner();
  await expect(runWorkflow({ script: invalidIsolation, resumeRunId: first.runId }, parent, {
    rootDir,
    runner: resumeRunner as never,
  })).rejects.toThrow("Invalid agent() options/isolation");
  expect(resumeRunner.calls).toHaveLength(0);
  expect(readFileSync(journalPath, "utf8")).toBe(journalBefore);

  const invalidCases = [
    ["{ tools: 'read' }", "/tools"],
    ["{ surprise: true }", "/surprise"],
    ["{ replay: 'rerun-on-context-change' }", "Invalid agent() options/replay: must not have additional properties"],
    ["{ replayKey: 'repo-sha' }", "Invalid agent() options/replayKey: must not have additional properties"],
    ["null", "must be object"],
  ] as const;
  for (const [agentOptions, expected] of invalidCases) {
    const runner = new FakeRunner();
    const script = `export const meta = { name: 'invalid-options', description: 'test' };
return agent('x', ${agentOptions});`;
    await expect(runWorkflow({ script }, parent, {
      rootDir: mkdtempSync(join(tmpdir(), "workflow-invalid-options-")),
      runner: runner as never,
    })).rejects.toThrow(expected);
    expect(runner.calls).toHaveLength(0);
  }
});

test("workflow runner parses string args, attributes phases, and replays before going live", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-runner-"));
  const script = `export const meta = { name: 'replay-test', description: 'test', phases: [{ title: 'First' }, { title: 'Second' }] };
await agent('stable');
phase('Second');
return agent('value-' + args.value, { phase: 'Precise' });`;
  const firstRunner = new FakeRunner();
  const first = await runWorkflow({ script, args: "{\"value\":1}" }, parent, { rootDir, runner: firstRunner as never });
  expect(firstRunner.calls.map((call) => call.phase)).toEqual(["First", "Precise"]);
  expect(firstRunner.delivered).toEqual([first.runId]);
  expect(readFileSync(join(first.runDir, "journal.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);

  const replayRunner = new FakeRunner();
  await runWorkflow({ script, resumeRunId: first.runId }, parent, { rootDir, runner: replayRunner as never });
  expect(replayRunner.calls).toHaveLength(0);

  const changedRunner = new FakeRunner();
  await runWorkflow({ script, args: { value: 2 }, resumeRunId: first.runId }, parent, { rootDir, runner: changedRunner as never });
  expect(changedRunner.calls.map((call) => call.prompt)).toEqual(["value-2"]);

  const latestArgsRunner = new FakeRunner();
  await runWorkflow({ script, resumeRunId: first.runId }, parent, { rootDir, runner: latestArgsRunner as never });
  expect(latestArgsRunner.calls).toHaveLength(0);
});

test("journal entries persist the resolved call fingerprint", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-fingerprint-"));
  const script = "export const meta = { name: 'fingerprint', description: 'test' }; return agent('inspect');";
  const result = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });

  const entry = JSON.parse(readFileSync(join(result.runDir, "journal.jsonl"), "utf8")) as { v: number; fingerprint: unknown };
  expect(entry.v).toBe(4);
  expect(entry.fingerprint).toEqual({
    version: 2,
    provider: "test",
    modelId: "parent-model",
    thinkingLevel: "off",
    cwd: "/work",
    extensionTools: [],
  });
});

// The fingerprint epoch is a hard replay gate: entries recorded under older
// child-resolution semantics (v1 = the in-process backend) must rerun, never
// replay, even when every other field still matches.
test("a fingerprint from an older epoch refuses replay even when fields match", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-fingerprint-epoch-"));
  const script = "export const meta = { name: 'fingerprint-epoch', description: 'test' }; return agent('inspect');";
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });

  const journalPath = join(first.runDir, "journal.jsonl");
  const entry = JSON.parse(readFileSync(journalPath, "utf8")) as { fingerprint: { version: number } };
  entry.fingerprint.version = 1;
  writeFileSync(journalPath, `${JSON.stringify(entry)}\n`);

  await expect(runWorkflow({ script, resumeRunId: first.runId }, parent, { rootDir, runner: new FakeRunner() as never }))
    .rejects.toThrow(/version/);
});

test("a v1 fingerprint with the legacy exclusions field refuses replay only for version drift", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-fingerprint-legacy-extra-"));
  const script = "export const meta = { name: 'fingerprint-legacy-extra', description: 'test' }; return agent('inspect');";
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });
  const journalPath = join(first.runDir, "journal.jsonl");
  const entry = JSON.parse(readFileSync(journalPath, "utf8")) as { fingerprint: { version: number; childExtensionExclusions?: string[] } };
  entry.fingerprint.version = 1;
  entry.fingerprint.childExtensionExclusions = ["legacy-tool"];
  writeFileSync(journalPath, `${JSON.stringify(entry)}\n`);

  const error = await runWorkflow({ script, resumeRunId: first.runId }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
  }).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("version was 1 and is now 2");
  expect((error as Error).message).not.toContain("childExtensionExclusions");
});

// Scenario: a completed call's environment changed and the call grants no
// rerun permission. The resume must fail closed before re-executing it (its
// side effects are done), leaving the journal intact for an authorized retry.
test("resume fails closed on environment drift without rerunning the completed call", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-drift-closed-"));
  const script = "export const meta = { name: 'drift-closed', description: 'test' }; return agent('mutate the workspace');";
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });
  const journalBefore = readFileSync(join(first.runDir, "journal.jsonl"), "utf8");
  const changedParent = {
    ...parent,
    ctx: { ...parent.ctx, model: { provider: "test", id: "new-model" } },
  } as unknown as ParentContext;
  const resumeRunner = new FakeRunner();

  const error = await runWorkflow({ script, resumeRunId: first.runId }, changedParent, {
    rootDir,
    runner: resumeRunner as never,
  }).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("Cannot replay workflow call child-1");
  expect((error as Error).message).toContain('modelId was "parent-model" and is now "new-model"');
  expect((error as Error).message).toContain('resume with rerunChildIds: ["child-1"]');
  expect(resumeRunner.calls).toHaveLength(0);
  expect(readFileSync(join(first.runDir, "journal.jsonl"), "utf8")).toBe(journalBefore);
  // A refusal that mutated nothing must leave the run as terminal as it was:
  // the completed status is reinstated and the delivered result survives.
  expect(JSON.parse(readFileSync(join(first.runDir, "status.json"), "utf8")).status).toBe("completed");
  expect(JSON.parse(readFileSync(join(first.runDir, "result.json"), "utf8"))).toBe("result-1");
  const refusalEvents = readFileSync(join(first.runDir, "events.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { type: string })
    .filter((event) => event.type === "workflow_resume_refused");
  expect(refusalEvents).toHaveLength(1);
});

// Scenario: the environment cannot even be resolved for a completed call (a
// pinned model was removed from the registry). That is a replay refusal, not
// a run failure - the terminal run must survive it.
test("an unresolvable pinned model refuses replay without tearing down the run", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-unresolvable-model-"));
  const knownRegistry = { find: (provider: string, id: string) => ({ provider, id }), getAll: () => [] };
  const launchParent = { ...parent, ctx: { ...parent.ctx, modelRegistry: knownRegistry } } as unknown as ParentContext;
  const script = `export const meta = { name: 'unresolvable-model', description: 'test' };
return agent('pinned', { model: 'test/vanishing-model' });`;
  const first = await runWorkflow({ script }, launchParent, { rootDir, runner: new FakeRunner() as never });

  const emptyRegistry = { find: () => undefined, getAll: () => [] };
  const resumeParent = { ...parent, ctx: { ...parent.ctx, modelRegistry: emptyRegistry } } as unknown as ParentContext;
  const resumeRunner = new FakeRunner();
  const error = await runWorkflow({ script, resumeRunId: first.runId }, resumeParent, {
    rootDir,
    runner: resumeRunner as never,
  }).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("the current execution environment cannot be resolved");
  expect(resumeRunner.calls).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(first.runDir, "status.json"), "utf8")).status).toBe("completed");
  expect(JSON.parse(readFileSync(join(first.runDir, "result.json"), "utf8"))).toBe("result-1");
});

test("rerunChildIds naming no journaled call is rejected before the generation commits", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-rerun-unknown-"));
  const script = "export const meta = { name: 'rerun-unknown', description: 'test' }; return agent('stable');";
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });
  const resumeRunner = new FakeRunner();

  const error = await runWorkflow({ script, resumeRunId: first.runId, rerunChildIds: ["child-typo"] }, parent, {
    rootDir,
    runner: resumeRunner as never,
  }).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('rerunChildIds ["child-typo"] match no journaled call');
  expect(resumeRunner.calls).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(first.runDir, "status.json"), "utf8")).status).toBe("completed");
  const started = readFileSync(join(first.runDir, "events.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { type: string; rerunChildIds?: string[] })
    .filter((event) => event.type === "workflow_started");
  // The refused authorization was never durably recorded as a phantom grant.
  expect(started).toHaveLength(1);
  expect(started[0]!.rerunChildIds).toBeUndefined();
});

// A refused resume that EDITED the script (or overrode args) already
// committed those canonical files, so reinstating "completed" would pair the
// old result with inputs that never produced it. Such a refusal must land as
// an honest failure while the identical-inputs refusal keeps restoring.
test("a refusal under an edited script fails instead of mixing generations", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-refusal-edited-"));
  const script = `export const meta = { name: 'refusal-edited', description: 'test' };
const value = await agent('mutating step');
return 'old-result';`;
  const first = await runWorkflow({ script, args: { generation: 1 } }, parent, { rootDir, runner: new FakeRunner() as never });
  const edited = script.replace("'old-result'", "'new-result'");
  const changedParent = {
    ...parent,
    ctx: { ...parent.ctx, model: { provider: "test", id: "new-model" } },
  } as unknown as ParentContext;

  await expect(runWorkflow({ script: edited, args: { generation: 2 }, resumeRunId: first.runId }, changedParent, {
    rootDir,
    runner: new FakeRunner() as never,
  })).rejects.toThrow("Cannot replay workflow call child-1");

  // No stale-completed mix: the refused generation reads as failed and the
  // prior generation's result does not survive next to the new inputs.
  expect(JSON.parse(readFileSync(join(first.runDir, "status.json"), "utf8")).status).toBe("failed");
  expect(existsSync(join(first.runDir, "result.json"))).toBe(false);
  expect(readFileSync(join(first.runDir, "script.js"), "utf8")).toBe(edited);
  expect(JSON.parse(readFileSync(join(first.runDir, "args.json"), "utf8"))).toEqual({ generation: 2 });
  // The journal is untouched either way, so an authorized retry still works.
  const journal = readFileSync(join(first.runDir, "journal.jsonl"), "utf8").trim().split("\n");
  expect(journal).toHaveLength(1);
});

// The refusal's own recovery path must work on the same run: refuse, then
// authorize, on one run directory.
test("a refused resume can immediately be authorized on the same run", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-refuse-then-authorize-"));
  const script = "export const meta = { name: 'refuse-then-authorize', description: 'test' }; return agent('mutating step');";
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });
  const changedParent = {
    ...parent,
    ctx: { ...parent.ctx, model: { provider: "test", id: "new-model" } },
  } as unknown as ParentContext;

  await expect(runWorkflow({ script, resumeRunId: first.runId }, changedParent, {
    rootDir,
    runner: new FakeRunner() as never,
  })).rejects.toThrow("Cannot replay workflow call child-1");
  expect(JSON.parse(readFileSync(join(first.runDir, "status.json"), "utf8")).status).toBe("completed");

  const authorizedRunner = new FakeRunner();
  await expect(runWorkflow({ script, resumeRunId: first.runId, rerunChildIds: ["child-1"] }, changedParent, {
    rootDir,
    runner: authorizedRunner as never,
  })).resolves.toMatchObject({ runId: first.runId });
  expect(authorizedRunner.calls.map((call) => call.prompt)).toEqual(["mutating step"]);
  expect(JSON.parse(readFileSync(join(first.runDir, "status.json"), "utf8")).status).toBe("completed");
});

// Scenario: the fail-closed error's recovery path. Authorizing the named
// entry reruns it and its causal descendants; the grant is recorded on the
// generation it applied to.
test("rerunChildIds authorizes exactly the named entry and its causal tail", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-rerun-authorized-"));
  const script = `export const meta = { name: 'rerun-authorized', description: 'test' };
const one = await agent('one');
return agent('two');`;
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });
  const changedParent = {
    ...parent,
    ctx: { ...parent.ctx, model: { provider: "test", id: "new-model" } },
  } as unknown as ParentContext;
  const resumeRunner = new FakeRunner();

  await expect(runWorkflow({ script, resumeRunId: first.runId, rerunChildIds: ["child-1"] }, changedParent, {
    rootDir,
    runner: resumeRunner as never,
  })).resolves.toMatchObject({ runId: first.runId });
  expect(resumeRunner.calls.map((call) => call.prompt)).toEqual(["one", "two"]);
  const started = readFileSync(join(first.runDir, "events.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { type: string; rerunChildIds?: string[] })
    .filter((event) => event.type === "workflow_started");
  expect(started).toHaveLength(2);
  expect(started[1]!.rerunChildIds).toEqual(["child-1"]);

  // The authorization applies only to this generation. A later drift must fail
  // closed again and name the replacement child for a new explicit decision.
  const driftedAgainParent = {
    ...changedParent,
    ctx: { ...changedParent.ctx, model: { provider: "test", id: "newer-model" } },
  } as unknown as ParentContext;
  const secondResumeRunner = new FakeRunner();
  const error = await runWorkflow({ script, resumeRunId: first.runId }, driftedAgainParent, {
    rootDir,
    runner: secondResumeRunner as never,
  }).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("Cannot replay workflow call child-3");
  expect((error as Error).message).toContain('resume with rerunChildIds: ["child-3"]');
  expect(secondResumeRunner.calls).toHaveLength(0);
});

test("rerunChildIds requires resumeRunId and non-empty ids", async () => {
  const script = "export const meta = { name: 'rerun-validate', description: 'test' }; return 'done';";
  await expect(runWorkflow({ script, rerunChildIds: ["child-1"] }, parent, { runner: new FakeRunner() as never }))
    .rejects.toThrow("requires resumeRunId");
  await expect(runWorkflow({ script, resumeRunId: "workflow-x", rerunChildIds: [" "] }, parent, { runner: new FakeRunner() as never }))
    .rejects.toThrow("non-empty array of persisted childId strings");
});

// Scenario: a branch authorized by childId reruns under drift while its
// completed sibling branch replays untouched.
test("a childId-authorized branch re-executes under drift and preserves completed siblings", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-drift-sibling-"));
  const registry = { find: (provider: string, id: string) => ({ provider, id }), getAll: () => [] };
  const launchParent = {
    ...parent,
    ctx: { ...parent.ctx, modelRegistry: registry },
  } as unknown as ParentContext;
  const script = `export const meta = { name: 'drift-sibling', description: 'test' };
return parallel([
  () => agent('pinned work', { model: 'test/pinned-model' }),
  () => agent('inherited work'),
]);`;
  const first = await runWorkflow({ script }, launchParent, { rootDir, runner: new FakeRunner() as never });
  const changedParent = {
    ...launchParent,
    ctx: { ...launchParent.ctx, model: { provider: "test", id: "new-model" } },
  } as unknown as ParentContext;
  const resumeRunner = new FakeRunner();

  await expect(runWorkflow({ script, resumeRunId: first.runId, rerunChildIds: ["child-2"] }, changedParent, {
    rootDir,
    runner: resumeRunner as never,
  })).resolves.toMatchObject({ runId: first.runId });
  // The pinned branch's fingerprint is unchanged, so it replays; only the
  // inherited branch re-executes.
  expect(resumeRunner.calls.map((call) => call.prompt)).toEqual(["inherited work"]);
});

// Scenario: an unchanged environment replays completed side-effectful work
// after a mid-run failure; only the unfinished call runs live.
test("ordinary resume after a mid-run failure never repeats the completed call", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-resume-no-repeat-"));
  const script = `export const meta = { name: 'resume-no-repeat', description: 'test' };
const done = await agent('mutating step');
const next = await agent('failing step');
if (next === null) throw new Error('second step failed');
return [done, next];`;
  const firstRunner = new FakeRunner();
  firstRunner.resultFactory = async (spec, number) => number === 2
    ? fakeResult(spec, number, { status: "failed", error: "boom" })
    : fakeResult(spec, number);
  await expect(runWorkflow({ script }, parent, { rootDir, runner: firstRunner as never })).rejects.toThrow("second step failed");
  const runId = firstRunner.registrations[0]!.runId;

  const resumeRunner = new FakeRunner();
  await expect(runWorkflow({ script, resumeRunId: runId }, parent, {
    rootDir,
    runner: resumeRunner as never,
  })).resolves.toMatchObject({ runId });
  expect(resumeRunner.calls.map((call) => call.prompt)).toEqual(["failing step"]);
});

// Scenario: a worktree child's persisted patch result replays verbatim on
// resume; no worktree is reconstructed and no child spawns.
test("a completed worktree call replays its patch result without respawning", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-worktree-replay-"));
  const script = `export const meta = { name: 'worktree-replay', description: 'test' };
const edit = await agent('edit files', { isolation: 'worktree' });
const summary = await agent('summarize ' + edit.changed.length);
if (summary === null) throw new Error('summary failed');
return summary;`;
  const firstRunner = new FakeRunner();
  firstRunner.resultFactory = async (spec, number) => number === 1
    ? fakeResult(spec, number, { patch: "diff --git a/a.txt b/a.txt", changed: ["a.txt"] })
    : fakeResult(spec, number, { status: "failed", error: "boom" });
  await expect(runWorkflow({ script }, parent, { rootDir, runner: firstRunner as never })).rejects.toThrow();
  const runId = firstRunner.registrations[0]!.runId;

  const resumeRunner = new FakeRunner();
  const resumed = await runWorkflow({ script, resumeRunId: runId }, parent, { rootDir, runner: resumeRunner as never });
  expect(resumeRunner.calls.map((call) => call.prompt)).toEqual(["summarize 1"]);
  expect(resumed.result).toBe("result-1");
});

test("workflow delivery drops the runner's store and handles", async () => {
  const resolved: ResolvedSpec = {
    provider: "test",
    modelId: "tiny",
    thinkingLevel: "off",
    tools: [],
    cwd: "/work",
    label: "delivered",
  };
  const runner = new SubagentRunner(async () => ({
    resolved,
    session: {
      sessionFile: "/delivered-child.jsonl",
      latestAssistant: undefined,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      subscribe: () => () => {},
      prompt: async () => {},
      steer: async () => {},
      abort: async () => {},
      dispose: async () => {},
    } as unknown as ChildSession,
  }));
  const script = "export const meta = { name: 'delivery-cleanup', description: 'test' }; return agent('done');";

  const result = await runWorkflow({ script }, parent, {
    rootDir: mkdtempSync(join(tmpdir(), "workflow-delivery-cleanup-")),
    runner,
  });
  for (let attempt = 0; runner.runHandles(result.runId).length > 0 && attempt < 10; attempt += 1) {
    await Bun.sleep(0);
  }

  expect((runner as unknown as { stores: Map<string, unknown> }).stores.has(result.runId)).toBe(false);
  expect(runner.runHandles(result.runId)).toEqual([]);
});

test("new journal entries carry format version 4 without usage replay state", async () => {
  const script = "export const meta = { name: 'journal-version', description: 'test' }; return agent('versioned');";
  const result = await runWorkflow({ script }, parent, {
    rootDir: mkdtempSync(join(tmpdir(), "workflow-journal-version-")),
    runner: new FakeRunner() as never,
  });

  const entry = JSON.parse(readFileSync(join(result.runDir, "journal.jsonl"), "utf8"));
  expect(entry.v).toBe(4);
  expect(entry).not.toHaveProperty("usage");
});

test("resume with an edited script replays the unchanged prefix and archives the original", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-edit-resume-"));
  const script = `export const meta = { name: 'edit-resume', description: 'test', phases: [{ title: 'Historical', detail: 'old work' }, { title: 'Removed' }] };
const a = await agent('stable-one', { phase: 'Historical' });
return a;`;
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });

  const edited = `export const meta = { name: 'edit-resume', description: 'test', phases: [{ title: 'Current', detail: 'new work' }] };
const a = await agent('stable-one', { phase: 'Historical' });
const b = await agent('new-call', { phase: 'Current' });
return b;`;
  const resumeRunner = new FakeRunner();
  await runWorkflow({ script: edited, resumeRunId: first.runId }, parent, { rootDir, runner: resumeRunner as never });
  expect(resumeRunner.calls.map((call) => call.prompt)).toEqual(["new-call"]);
  expect(readFileSync(join(first.runDir, "script.js"), "utf8")).toBe(edited);
  expect(readFileSync(join(first.runDir, "script.resumed-1.js"), "utf8")).toBe(script);
  expect(JSON.parse(readFileSync(join(first.runDir, "run.json"), "utf8")).phases).toEqual([
    { title: "Current", detail: "new work" },
    { title: "Historical", detail: "old work" },
  ]);

  const editedAgain = edited.replace("return b;", "return a;");
  await runWorkflow({ script: editedAgain, resumeRunId: first.runId }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
  });
  expect(readFileSync(join(first.runDir, "script.js"), "utf8")).toBe(editedAgain);
  expect(readFileSync(join(first.runDir, "script.resumed-1.js"), "utf8")).toBe(script);
  expect(readFileSync(join(first.runDir, "script.resumed-2.js"), "utf8")).toBe(edited);
});

test("a rejected resume validates input overrides before changing the stored script", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-resume-input-transaction-"));
  const original = "export const meta = { name: 'resume-inputs', description: 'test' }; return agent('original');";
  const edited = "export const meta = { name: 'resume-inputs', description: 'test' }; return agent('edited');";
  const first = await runWorkflow({ script: original }, parent, { rootDir, runner: new FakeRunner() as never });
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;

  await expect(runWorkflow({ script: edited, args: cyclic, resumeRunId: first.runId }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
  })).rejects.toThrow("JSON-serializable");

  expect(readFileSync(join(first.runDir, "script.js"), "utf8")).toBe(original);
  expect(existsSync(join(first.runDir, "script.resumed-1.js"))).toBe(false);
});

test("a queued resumed execution is no longer discoverable as completed when startup returns", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-resume-live-status-"));
  const original = "export const meta = { name: 'resume-live', description: 'test' }; return 'old';";
  const first = await runWorkflow({ script: original }, parent, { rootDir, runner: new FakeRunner() as never });
  const resumedScript = "export const meta = { name: 'resume-live', description: 'test' }; return agent('queued');";
  const runner = new FakeRunner();
  let finishChild!: () => void;
  runner.resultFactory = (spec, number) => new Promise((resolve) => {
    finishChild = () => resolve(fakeResult(spec, number));
  });
  const started = startParsedWorkflow({ workflow: parseWorkflowScript(resumedScript), resumeRunId: first.runId }, parent, {
    rootDir,
    runner: runner as never,
  });
  const statusAtStarted = JSON.parse(readFileSync(join(started.runDir, "status.json"), "utf8")).status;
  const discoveredAtStarted = findWorkflowRunById(parent.ctx.cwd, started.runId, rootDir) !== undefined;
  const latestAtStarted = findLatestCompletedWorkflowRun(parent.ctx.cwd, rootDir)?.runId;
  while (runner.calls.length === 0) await Bun.sleep(5);

  expect(statusAtStarted).toBe("running");
  expect(discoveredAtStarted).toBe(false);
  expect(latestAtStarted).toBeUndefined();
  expect(JSON.parse(readFileSync(join(first.runDir, "status.json"), "utf8")).status).toBe("running");
  expect(findWorkflowRunById(parent.ctx.cwd, first.runId, rootDir)).toBeUndefined();
  expect(findLatestCompletedWorkflowRun(parent.ctx.cwd, rootDir)).toBeUndefined();

  finishChild();
  await started.execution;
  expect(findWorkflowRunById(parent.ctx.cwd, first.runId, rootDir)?.runId).toBe(first.runId);
});

test("failed resume setup preserves terminal status and prior narration", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-resume-setup-failure-"));
  const script = "export const meta = { name: 'resume-setup', description: 'test' }; log('prior narration'); return 'done';";
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });
  const statusPath = join(first.runDir, "status.json");
  const statusBefore = readFileSync(statusPath, "utf8");
  writeFileSync(join(first.runDir, "args.json"), "{ broken");

  await expect(runWorkflow({ script, resumeRunId: first.runId }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
  })).rejects.toThrow("invalid args.json");

  expect(readFileSync(statusPath, "utf8")).toBe(statusBefore);
  expect(existsSync(join(first.runDir, OWNER_FILE))).toBe(false);
  const detail = readRunDetail(first.runDir, first.runId, { root: rootDir });
  expect(detail.narrator.map((line) => `${line.kind}:${line.text}`)).toEqual(["log:prior narration"]);
  const eventTypes = readFileSync(join(first.runDir, "events.jsonl"), "utf8").trim().split("\n")
    .map((line) => (JSON.parse(line) as { type: string }).type);
  expect(eventTypes.filter((type) => type === "workflow_started")).toHaveLength(1);
  expect(eventTypes.at(-1)).toBe("resumed");
});

test("a missing script during resume preserves status and releases ownership", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-resume-missing-script-"));
  const script = "export const meta = { name: 'missing-script', description: 'test' }; return 'done';";
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });
  const statusPath = join(first.runDir, "status.json");
  const statusBefore = readFileSync(statusPath, "utf8");
  rmSync(join(first.runDir, "script.js"));

  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(runWorkflow({ script, resumeRunId: first.runId }, parent, {
      rootDir,
      runner: new FakeRunner() as never,
    })).rejects.toThrow("does not contain script.js");
  } finally {
    errorLog.mockRestore();
  }

  expect(readFileSync(statusPath, "utf8")).toBe(statusBefore);
  expect(existsSync(join(first.runDir, OWNER_FILE))).toBe(false);
  const eventTypes = readFileSync(join(first.runDir, "events.jsonl"), "utf8").trim().split("\n")
    .map((line) => (JSON.parse(line) as { type: string }).type);
  expect(eventTypes.filter((type) => type === "workflow_started")).toHaveLength(1);
  expect(eventTypes.at(-1)).toBe("resumed");
});

test("an EISDIR journal failure preserves the entire completed generation", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-resume-journal-eisdir-"));
  const original = `export const meta = { name: 'journal-eisdir', description: 'test', phases: [{ title: 'Original' }] };
return agent('original');`;
  const first = await runWorkflow({ script: original, args: { generation: 1 } }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
  });
  const canonical = ["script.js", "run.json", "args.json", "status.json", "result.json"] as const;
  const before = Object.fromEntries(canonical.map((name) => [name, readFileSync(join(first.runDir, name), "utf8")])) as Record<typeof canonical[number], string>;
  const journalPath = join(first.runDir, "journal.jsonl");
  rmSync(journalPath);
  mkdirSync(journalPath);

  const edited = `export const meta = { name: 'journal-eisdir', description: 'test', phases: [{ title: 'Edited' }] };
return agent('must-not-run');`;
  const runner = new FakeRunner();
  await expect(runWorkflow({
    script: edited,
    args: { generation: 2 },
    resumeRunId: first.runId,
  }, parent, { rootDir, runner: runner as never })).rejects.toThrow();

  expect(runner.calls).toHaveLength(0);
  for (const name of canonical) expect(readFileSync(join(first.runDir, name), "utf8")).toBe(before[name]);
  expect(JSON.parse(before["status.json"]).status).toBe("completed");
  expect(JSON.parse(before["result.json"])).toBe("result-1");
  expect(existsSync(join(first.runDir, "script.resumed-1.js"))).toBe(false);
  const eventTypes = readFileSync(join(first.runDir, "events.jsonl"), "utf8").trim().split("\n")
    .map((line) => (JSON.parse(line) as { type: string }).type);
  expect(eventTypes.filter((type) => type === "workflow_started")).toHaveLength(1);
  expect(eventTypes.at(-1)).toBe("resumed");
});

test("workflow lifetime cap reports cap and attempted count", async () => {
  const script = `export const meta = { name: 'cap-test', description: 'test' };\nfor (let i = 0; i <= ${WORKFLOW_AGENT_CAP}; i++) await agent('x-' + i);`;
  await expect(runWorkflow({ script }, parent, { rootDir: mkdtempSync(join(tmpdir(), "workflow-cap-")), runner: new FakeRunner() as never })).rejects.toThrow(`cap is ${WORKFLOW_AGENT_CAP}; attempted call count ${WORKFLOW_AGENT_CAP + 1}`);
});

test("new workflows capture the fixed lifetime cap in run metadata", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-fixed-cap-"));
  const script = "export const meta = { name: 'fixed-cap', description: 'test' }; return 'done';";
  const result = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });

  expect(JSON.parse(readFileSync(join(result.runDir, "run.json"), "utf8")).workflowPolicy)
    .toEqual({ maxAgentsPerWorkflow: WORKFLOW_AGENT_CAP });
});

test("resume honors a different cap persisted by an earlier version", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-resume-cap-"));
  const original = `export const meta = { name: 'resume-cap', description: 'test' };
await agent('one'); return agent('two');`;
  const first = await runWorkflow({ script: original }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
  });
  const runPath = join(first.runDir, "run.json");
  const record = JSON.parse(readFileSync(runPath, "utf8"));
  record.workflowPolicy = { maxAgentsPerWorkflow: 2 };
  writeFileSync(runPath, JSON.stringify(record));
  const edited = `export const meta = { name: 'resume-cap', description: 'test' };
await agent('one'); await agent('two'); return agent('three');`;

  await expect(runWorkflow({ script: edited, resumeRunId: first.runId }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
  })).rejects.toThrow("cap is 2; attempted call count 3");
});

test("workflow lifetime cap includes children admitted by earlier resume attempts", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-resume-lifetime-cap-"));
  const original = `export const meta = { name: 'resume-lifetime-cap', description: 'test' };
return 'done';`;
  const first = await runWorkflow({ script: original }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
  });
  const runPath = join(first.runDir, "run.json");
  const record = JSON.parse(readFileSync(runPath, "utf8"));
  record.workflowPolicy = { maxAgentsPerWorkflow: 2 };
  record.children = [
    { id: "prior-1", spec: { prompt: "prior one" } },
    { id: "prior-2", spec: { prompt: "prior two" } },
  ];
  writeFileSync(runPath, JSON.stringify(record));

  const edited = `export const meta = { name: 'resume-lifetime-cap', description: 'test' };
await agent('new'); return 'done';`;
  await expect(runWorkflow({ script: edited, resumeRunId: first.runId }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
  })).rejects.toThrow("cap is 2; attempted call count 3");
});

test("args JSON string parsing is defensive", () => {
  expect(normalizeArgs("{\"ok\":true}")).toEqual({ ok: true });
  expect(normalizeArgs("plain")).toBe("plain");
});

test("stopping a run cancels the loop so later agents never spawn", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-stop-"));
  const script = `export const meta = { name: 'stop-test', description: 'test' };
await agent('a'); await agent('b'); await agent('c'); return 'done';`;
  const runner = new FakeRunner();
  runner.stopAfter = 1; // abort the run controller once the first agent spawns
  await expect(runWorkflow({ script }, parent, { rootDir, runner: runner as never })).rejects.toThrow("Workflow stopped");
  expect(runner.calls.map((c) => c.prompt)).toEqual(["a"]); // b and c never spawned
  expect(runner.controllers.size).toBe(0); // controller unregistered in finally
});

test("editing owner metadata does not revoke a live workflow's ownership", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-owner-metadata-"));
  const script = `export const meta = { name: 'owner-metadata', description: 'test' };
const value = await agent('pause');
log('still persists');
return value;`;
  const runner = new FakeRunner();
  let finishChild!: (result: SubagentResult) => void;
  runner.resultFactory = () => new Promise((resolve) => {
    finishChild = (result) => resolve(result);
  });
  const { runDir, execution } = startParsedWorkflow({ workflow: parseWorkflowScript(script) }, parent, {
    rootDir,
    runner: runner as never,
  });
  while (runner.calls.length === 0) await Bun.sleep(5);
  const ownerPath = join(runDir, OWNER_FILE);
  const replacement = JSON.parse(readFileSync(ownerPath, "utf8"));
  replacement.pid = 4242;
  writeFileSync(ownerPath, JSON.stringify(replacement));
  finishChild(fakeResult(runner.calls[0]!, 1));

  const completed = await execution;
  expect(completed.result).toBe("result-1");
  expect(runner.controllers.size).toBe(0);
  expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain("still persists");
  expect(JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")).status).toBe("completed");
  expect(existsSync(join(runDir, "journal.jsonl"))).toBe(true);
  expect(existsSync(ownerPath)).toBe(false);
});

test("a large zero-agent result is persisted atomically before the run is marked completed", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-result-durability-"));
  const big = "x".repeat(20_000);
  const script = `export const meta = { name: 'big-result', description: 'test' };
return ${JSON.stringify(big)};`;
  const runner = new FakeRunner();
  let resultPresentAtFinish: boolean | undefined;
  const finish = RunStore.prototype.workflowFinished;
  const spy = spyOn(RunStore.prototype, "workflowFinished").mockImplementation(function (this: RunStore, status, error) {
    if (status === "completed") resultPresentAtFinish = existsSync(join(this.runDir, "result.json"));
    return finish.call(this, status, error);
  });
  try {
    const result = await runWorkflow({ script }, parent, { rootDir, runner: runner as never });
    expect(runner.calls).toHaveLength(0);
    expect(big.length).toBeGreaterThan(16_000);
    expect(result.result).toBe(big);
    expect(result.persistenceWarning).toBeUndefined();
    // Ordering: result.json is durable at the instant completion is committed.
    expect(resultPresentAtFinish).toBe(true);
    expect(JSON.parse(readFileSync(join(result.runDir, "result.json"), "utf8"))).toBe(big);
  } finally {
    spy.mockRestore();
  }
});

test("a workflow that returns nothing writes no result artifact", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-result-undefined-"));
  const script = "export const meta = { name: 'no-result', description: 'test' }; log('done');";
  const result = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });
  expect(result.result).toBeUndefined();
  expect(existsSync(join(result.runDir, "result.json"))).toBe(false);
});

test("a resume returning undefined removes the prior generation result before completion", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-result-remove-"));
  const defined = "export const meta = { name: 'result-remove', description: 'test' }; return { stale: true };";
  const first = await runWorkflow({ script: defined }, parent, { rootDir, runner: new FakeRunner() as never });
  expect(JSON.parse(readFileSync(join(first.runDir, "result.json"), "utf8"))).toEqual({ stale: true });

  const undefinedResult = "export const meta = { name: 'result-remove', description: 'test' }; log('no result');";
  const resumed = await runWorkflow({ script: undefinedResult, resumeRunId: first.runId }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
  });

  expect(resumed.result).toBeUndefined();
  expect(existsSync(join(first.runDir, "result.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(first.runDir, "status.json"), "utf8")).status).toBe("completed");
});

test("a failed resume removes the prior generation result", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-result-failed-resume-"));
  const completed = "export const meta = { name: 'failed-resume', description: 'test' }; return { stale: true };";
  const first = await runWorkflow({ script: completed }, parent, { rootDir, runner: new FakeRunner() as never });
  expect(existsSync(join(first.runDir, "result.json"))).toBe(true);

  const failed = "export const meta = { name: 'failed-resume', description: 'test' }; throw new Error('new generation failed');";
  await expect(runWorkflow({ script: failed, resumeRunId: first.runId }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
  })).rejects.toThrow("new generation failed");

  expect(existsSync(join(first.runDir, "result.json"))).toBe(false);
  expect(JSON.parse(readFileSync(join(first.runDir, "status.json"), "utf8")).status).toBe("failed");
});

test("an aborted resume setup does not publish the edited script generation", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-resume-setup-abort-"));
  const original = "export const meta = { name: 'setup-abort', description: 'test' }; return 'old';";
  const first = await runWorkflow({ script: original }, parent, { rootDir, runner: new FakeRunner() as never });
  const statusBefore = readFileSync(join(first.runDir, "status.json"), "utf8");
  const edited = original.replace("'old'", "'new'");
  const controller = new AbortController();
  controller.abort();

  await expect(runWorkflow({ script: edited, resumeRunId: first.runId }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
    signal: controller.signal,
  })).rejects.toThrow("Workflow stopped");

  expect(readFileSync(join(first.runDir, "script.js"), "utf8")).toBe(original);
  expect(readFileSync(join(first.runDir, "status.json"), "utf8")).toBe(statusBefore);
  expect(existsSync(join(first.runDir, "script.resumed-1.js"))).toBe(false);
});

test("a failed result persist prevents a false completed status and leaks no staging file", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-result-persist-fail-"));
  const script = "export const meta = { name: 'result-persist-fail', description: 'test' }; return 'the-value';";
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    const started = startParsedWorkflow({ workflow: parseWorkflowScript(script) }, parent, {
      rootDir,
      runner: new FakeRunner() as never,
    });
    // Occupy result.json before deferred body execution so the atomic rename cannot land.
    mkdirSync(join(started.runDir, "result.json"));
    await expect(started.execution).rejects.toThrow();
    expect(JSON.parse(readFileSync(join(started.runDir, "status.json"), "utf8")).status).toBe("failed");
    expect(readdirSync(started.runDir).filter((name) => name.startsWith("result.json.tmp-"))).toEqual([]);
  } finally {
    errorLog.mockRestore();
  }
});

test("a non-JSON-serializable workflow return fails the run before it is marked completed", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-badreturn-"));
  const script = `export const meta = { name: 'bad-return', description: 'test' };
const cyclic = {}; cyclic.self = cyclic; return cyclic;`;
  await expect(runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never }))
    .rejects.toThrow("not JSON-serializable");
});

test("an edited resume truncates the journal's stale tail at the first miss", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-truncate-"));
  const script = `export const meta = { name: 'truncate-test', description: 'test' };
await agent('one');
await agent('two-a');
return agent('three');`;
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });
  const journalPath = join(first.runDir, "journal.jsonl");
  expect(readFileSync(journalPath, "utf8").trim().split("\n")).toHaveLength(3);

  // Edited resume changes the middle call, then crashes before the third call
  // re-runs. The stale index-2 entry must be gone: without truncation, the
  // next resume would splice it in as if it were an unchanged prefix.
  const crashing = `export const meta = { name: 'truncate-test', description: 'test' };
await agent('one');
await agent('two-b');
throw new Error('boom');`;
  await expect(runWorkflow({ script: crashing, resumeRunId: first.runId }, parent, { rootDir, runner: new FakeRunner() as never })).rejects.toThrow("boom");
  const afterCrash = readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { call: { operation: number } });
  expect(afterCrash.map((entry) => entry.call.operation)).toEqual([0, 1]);

  // Recovery resume: the unchanged prefix replays, and 'three' runs live
  // (its stale pre-edit result no longer masquerades as current).
  const recovered = `export const meta = { name: 'truncate-test', description: 'test' };
await agent('one');
await agent('two-b');
return agent('three');`;
  const resumeRunner = new FakeRunner();
  await runWorkflow({ script: recovered, resumeRunId: first.runId }, parent, { rootDir, runner: resumeRunner as never });
  expect(resumeRunner.calls.map((call) => call.prompt)).toEqual(["three"]);
});

test("resume is refused while the run is active in this session", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-active-resume-"));
  const script = "export const meta = { name: 'active', description: 'test' }; return 1;";
  const runner = new FakeRunner() as FakeRunner & { isRunActive: (runId: string) => boolean };
  runner.isRunActive = () => true;
  await expect(runWorkflow({ script, resumeRunId: "workflow-live-1" }, parent, { rootDir, runner: runner as never })).rejects.toThrow("still active in this session");
});

test("resume is refused while another owner holds the run", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-owned-resume-"));
  const script = "export const meta = { name: 'owned', description: 'test' }; return agent('x');";
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });
  const owner = acquireRunOwnership(first.runDir);
  try {
    const edited = "export const meta = { name: 'owned', description: 'test' }; return agent('edited');";
    await expect(runWorkflow({ script: edited, resumeRunId: first.runId }, parent, { rootDir, runner: new FakeRunner() as never })).rejects.toThrow("active in another process");
    expect(readFileSync(join(first.runDir, "script.js"), "utf8")).toBe(script);
    expect(existsSync(join(first.runDir, "script.resumed-1.js"))).toBe(false);
  } finally {
    owner.release();
  }
});

test("workflow resume rejects traversal ids with a clear error", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-resume-"));
  const script = "export const meta = { name: 'resume-test', description: 'test' }; return 1;";

  await expect(runWorkflow({ script, resumeRunId: "../workflow-escape-1" }, parent, { rootDir })).rejects.toThrow("Cannot resume workflow: Invalid run id");
  await expect(runWorkflow({ script, resumeRunId: "/tmp/workflow-escape-1" }, parent, { rootDir })).rejects.toThrow("Cannot resume workflow: Invalid run id");
});

test("pipeline replay uses stable item lineage when host completion order differs", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-pipeline-lineage-"));
  const script = `export const meta = { name: 'pipeline-lineage', description: 'test' };
return pipeline(['slow', 'fast'],
  async item => agent('stage-one-' + item),
  async () => agent('symmetric-stage-two'));
`;
  const firstRunner = new FakeRunner();
  firstRunner.resultFactory = async (spec, number) => {
    if (spec.prompt === "stage-one-slow") await Bun.sleep(30);
    return fakeResult(spec, number);
  };
  const first = await runWorkflow({ script }, parent, { rootDir, runner: firstRunner as never });
  // Fast finishes its host call first, but VM continuations resume in accepted
  // request order. Live and replay therefore create stage two in item order.
  expect(first.result).toEqual(["result-3", "result-4"]);

  const replayRunner = new FakeRunner();
  const replay = await runWorkflow({ script, resumeRunId: first.runId }, parent, { rootDir, runner: replayRunner as never });
  expect(replayRunner.calls).toHaveLength(0);
  expect(replay.result).toEqual(first.result);
});

test("parallel partial failure preserves a successful sibling for resume", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-partial-resume-"));
  const script = `export const meta = { name: 'partial-resume', description: 'test' };
const values = await parallel([() => agent('low'), () => agent('high')]);
if (values[0] === null) throw new Error('recover low');
return values;`;
  const firstRunner = new FakeRunner();
  firstRunner.resultFactory = async (spec, number) => spec.prompt === "low"
    ? fakeResult(spec, number, { status: "failed", error: "first attempt failed" })
    : fakeResult(spec, number);
  await expect(runWorkflow({ script }, parent, { rootDir, runner: firstRunner as never })).rejects.toThrow("recover low");
  const runId = firstRunner.registrations[0]!.runId;

  const resumeRunner = new FakeRunner();
  const resumed = await runWorkflow({ script, resumeRunId: runId }, parent, { rootDir, runner: resumeRunner as never });
  expect(resumeRunner.calls.map((call) => call.prompt)).toEqual(["low"]);
  expect(resumed.result).toEqual(["result-1", "result-2"]);
});

test("removing a parallel group invalidates its old branch results", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-removed-parallel-"));
  const grouped = `export const meta = { name: 'removed-parallel', description: 'test' };
return parallel([() => agent('left'), () => agent('right')]);`;
  const first = await runWorkflow({ script: grouped }, parent, { rootDir, runner: new FakeRunner() as never });

  const sequential = `export const meta = { name: 'removed-parallel', description: 'test' };
const left = await agent('left');
const right = await agent('right');
return [left, right];`;
  const resumeRunner = new FakeRunner();
  await runWorkflow({ script: sequential, resumeRunId: first.runId }, parent, { rootDir, runner: resumeRunner as never });

  expect(resumeRunner.calls.map((call) => call.prompt)).toEqual(["left", "right"]);
});

test("pipeline partial failure preserves a successful item for resume", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-pipeline-partial-resume-"));
  const script = `export const meta = { name: 'pipeline-partial-resume', description: 'test' };
const values = await pipeline(['low', 'high'], item => agent(item));
if (values[0] === null) throw new Error('recover low');
return values;`;
  const firstRunner = new FakeRunner();
  firstRunner.resultFactory = async (spec, number) => spec.prompt === "low"
    ? fakeResult(spec, number, { status: "failed", error: "first attempt failed" })
    : fakeResult(spec, number);
  await expect(runWorkflow({ script }, parent, { rootDir, runner: firstRunner as never })).rejects.toThrow("recover low");
  const runId = firstRunner.registrations[0]!.runId;

  const resumeRunner = new FakeRunner();
  const resumed = await runWorkflow({ script, resumeRunId: runId }, parent, { rootDir, runner: resumeRunner as never });
  expect(resumeRunner.calls.map((call) => call.prompt)).toEqual(["low"]);
  expect(resumed.result).toEqual(["result-1", "result-2"]);
});

test("parallel failedChildren are reported in stable branch order", async () => {
  const runner = new FakeRunner();
  runner.resultFactory = async (spec, number) => {
    if (spec.prompt === "left") await Bun.sleep(25);
    return fakeResult(spec, number, { status: "failed", error: `failed ${spec.prompt}` });
  };
  const script = `export const meta = { name: 'failure-order', description: 'test' };
return parallel([() => agent('left'), () => agent('right')]);`;
  const result = await runWorkflow({ script }, parent, {
    rootDir: mkdtempSync(join(tmpdir(), "workflow-failure-order-")),
    runner: runner as never,
  });

  expect(result.failedChildren.map((child) => child.error)).toEqual(["failed left", "failed right"]);
});

test("guarded child failures survive real workflow execution and wait serialization", async () => {
  const runner = new FakeRunner();
  runner.resultFactory = async (spec, number) => fakeResult(spec, number, {
    status: "failed",
    error: "guarded failure",
    resolved: {
      provider: "test",
      modelId: "failed-model",
      thinkingLevel: "off",
      tools: [],
      cwd: "/work",
      label: "resolved failure label",
    },
  });
  const script = `export const meta = { name: 'guarded-failure', description: 'test' };
const child = await agent('may fail');
return { got: child === null };`;

  const result = await runWorkflow({ script }, parent, {
    rootDir: mkdtempSync(join(tmpdir(), "workflow-guarded-failure-")),
    runner: runner as never,
  });
  expect(result.result).toEqual({ got: true });
  expect(JSON.parse(formatWorkflowResult(result))).toMatchObject({
    type: "workflow_result",
    result: { got: true },
    failedChildren: [{
      id: "child-1",
      error: "guarded failure",
      resolved: { label: "resolved failure label" },
    }],
  });
});

test("pre-lineage journals refuse resume with a typed error", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-pre-lineage-"));
  const script = "export const meta = { name: 'pre-lineage', description: 'test' }; return agent('same');";
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });
  const journalPath = join(first.runDir, "journal.jsonl");
  const entry = JSON.parse(readFileSync(journalPath, "utf8"));
  writeFileSync(journalPath, `${JSON.stringify({ index: 0, hash: entry.hash, result: entry.result, childId: entry.childId })}\n`);
  const statusBefore = readFileSync(join(first.runDir, "status.json"), "utf8");

  const resumeRunner = new FakeRunner();
  const error = await runWorkflow({ script, resumeRunId: first.runId }, parent, {
    rootDir,
    runner: resumeRunner as never,
  }).then(() => undefined, (caught: unknown) => caught);

  expect(error).toBeInstanceOf(JournalUnreadableError);
  expect((error as Error).message).toBe(
    `Cannot resume workflow: journal ${journalPath} line 1 predates the current format, so this run cannot be resumed. Re-run the workflow fresh.`,
  );
  expect(resumeRunner.calls).toHaveLength(0);
  expect(readFileSync(join(first.runDir, "status.json"), "utf8")).toBe(statusBefore);
  expect(existsSync(join(first.runDir, OWNER_FILE))).toBe(false);
});

test("a torn final journal line is tolerated and its call re-runs", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-torn-journal-"));
  const script = `export const meta = { name: 'torn-journal', description: 'test' };
const first = await agent('first');
const second = await agent('second');
return [first, second];`;
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });
  const journalPath = join(first.runDir, "journal.jsonl");
  const lines = readFileSync(journalPath, "utf8").trim().split("\n");
  writeFileSync(journalPath, `${lines[0]}\n{"v":2,"call":`);

  const resumeRunner = new FakeRunner();
  await runWorkflow({ script, resumeRunId: first.runId }, parent, { rootDir, runner: resumeRunner as never });

  expect(resumeRunner.calls.map((call) => call.prompt)).toEqual(["second"]);
  const repaired = readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(repaired).toHaveLength(2);
  expect(repaired.map((entry) => entry.v)).toEqual([4, 4]);
});

test("worktree agent results retain value, patch, and changed paths", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-isolation-result-"));
  const script = `export const meta = { name: 'isolation-result', description: 'test' };
return agent('edit', { isolation: 'worktree' });`;
  const runner = new FakeRunner();
  runner.resultFactory = async (spec, number) => fakeResult(spec, number, {
    structured: { ok: true },
    patch: "diff --git a/a.txt b/a.txt",
    changed: ["a.txt"],
  });
  const result = await runWorkflow({ script }, parent, { rootDir, runner: runner as never });
  expect(result.result).toEqual({ value: { ok: true }, patch: "diff --git a/a.txt b/a.txt", changed: ["a.txt"] });
  const replayRunner = new FakeRunner();
  const replay = await runWorkflow({ script, resumeRunId: result.runId }, parent, { rootDir, runner: replayRunner as never });
  expect(replayRunner.calls).toHaveLength(0);
  expect(replay.result).toEqual(result.result);
});

test("oversized worktree patches fail before workflow journaling or worker delivery", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-oversized-patch-"));
  const script = `export const meta = { name: 'oversized-patch', description: 'test' };
return agent('edit', { isolation: 'worktree' });`;
  const runner = new FakeRunner();
  runner.resultFactory = async (spec, number) => fakeResult(spec, number, {
    patch: "x".repeat(MAX_INLINE_WORKTREE_PATCH_BYTES + 1),
    changed: ["large.txt"],
  });

  await expect(runWorkflow({ script }, parent, { rootDir, runner: runner as never }))
    .rejects.toThrow("inline safety limit");
  const runDir = join(rootDir, encodeCwd("/work"), runner.registrations[0]!.runId);
  expect(existsSync(join(runDir, "journal.jsonl"))).toBe(false);
});

test("resume discards an oversized inline worktree patch instead of replaying it", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-oversized-replay-"));
  const script = `export const meta = { name: 'oversized-replay', description: 'test' };
return agent('edit', { isolation: 'worktree' });`;
  const firstRunner = new FakeRunner();
  firstRunner.resultFactory = async (spec, number) => fakeResult(spec, number, {
    patch: "safe-original",
    changed: ["a.txt"],
  });
  const first = await runWorkflow({ script }, parent, { rootDir, runner: firstRunner as never });
  const journalPath = join(first.runDir, "journal.jsonl");
  const poisoned = JSON.parse(readFileSync(journalPath, "utf8"));
  poisoned.result.patch = "x".repeat(MAX_INLINE_WORKTREE_PATCH_BYTES + 1);
  writeFileSync(journalPath, `${JSON.stringify(poisoned)}\n`);

  const resumeRunner = new FakeRunner();
  resumeRunner.resultFactory = async (spec, number) => fakeResult(spec, number, {
    patch: "safe-replacement",
    changed: ["b.txt"],
  });
  const resumed = await runWorkflow({ script, resumeRunId: first.runId }, parent, {
    rootDir,
    runner: resumeRunner as never,
  });

  expect(resumeRunner.calls.map((call) => call.prompt)).toEqual(["edit"]);
  expect(resumed.result).toEqual({ value: "result-1", patch: "safe-replacement", changed: ["b.txt"] });
  expect(JSON.parse(readFileSync(journalPath, "utf8")).result.patch).toBe("safe-replacement");
});

test("an already-aborted external signal stops before workflow execution", async () => {
  const controller = new AbortController();
  controller.abort();
  const script = "export const meta = { name: 'pre-aborted', description: 'test' }; return 1;";
  await expect(runWorkflow({ script }, parent, {
    rootDir: mkdtempSync(join(tmpdir(), "workflow-pre-aborted-")),
    runner: new FakeRunner() as never,
    signal: controller.signal,
  })).rejects.toThrow("Workflow stopped");
});

test("external abort forwarding removes the listener it registered", async () => {
  let added: EventListenerOrEventListenerObject | undefined;
  let removed: EventListenerOrEventListenerObject | undefined;
  const signal = {
    aborted: false,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { added = listener; },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { removed = listener; },
  } as unknown as AbortSignal;
  const script = "export const meta = { name: 'signal-cleanup', description: 'test' }; return 1;";
  await runWorkflow({ script }, parent, {
    rootDir: mkdtempSync(join(tmpdir(), "workflow-signal-cleanup-")),
    runner: new FakeRunner() as never,
    signal,
  });
  expect(removed).toBe(added);
});

test("a throwing external signal binding releases ownership before controller registration", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-signal-throw-"));
  const runner = new FakeRunner() as FakeRunner & { isRunActive: (runId: string) => boolean };
  runner.isRunActive = (runId) => runner.controllers.has(runId);
  const primary = new Error("broken signal listener registration");
  const signal = {
    aborted: false,
    addEventListener: () => { throw primary; },
    removeEventListener: () => {},
  } as unknown as AbortSignal;
  const script = "export const meta = { name: 'signal-throw', description: 'test' }; return 1;";
  let error: unknown;
  try {
    startParsedWorkflow({ workflow: parseWorkflowScript(script) }, parent, {
      rootDir,
      runner: runner as never,
      signal,
    });
  } catch (caught) {
    error = caught;
  }

  expect(error).toBe(primary);
  expect(runner.registrations).toHaveLength(0);

  const runId = readdirSync(join(rootDir, encodeCwd(parent.ctx.cwd)))[0]!;
  const runDir = resolveRunDir(parent.ctx.cwd, runId, rootDir);
  expect(probeSqliteLock(join(runDir, "owner.sqlite"))).toBe("free");
  const resumed = await runWorkflow({ script, resumeRunId: runId }, parent, {
    rootDir,
    runner: runner as never,
  });
  expect(resumed.result).toBe(1);
});

test("malformed persisted children refuse resume and release ownership", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "workflow-malformed-children-"));
  const script = "export const meta = { name: 'malformed-children', description: 'test' }; return 1;";
  const first = await runWorkflow({ script }, parent, { rootDir, runner: new FakeRunner() as never });
  const runPath = join(first.runDir, "run.json");
  const record = JSON.parse(readFileSync(runPath, "utf8"));
  record.children = null;
  writeFileSync(runPath, JSON.stringify(record));

  const error = await runWorkflow({ script, resumeRunId: first.runId }, parent, {
    rootDir,
    runner: new FakeRunner() as never,
  }).then(() => undefined, (caught: unknown) => caught);

  expect(error).toBeInstanceOf(TypeError);
  expect(probeSqliteLock(join(first.runDir, "owner.sqlite"))).toBe("free");
});

test("workflow controller registration carries its parent session id", async () => {
  const runner = new FakeRunner();
  const script = "export const meta = { name: 'controller-owner', description: 'test' }; return 1;";
  await runWorkflow({ script }, parent, {
    rootDir: mkdtempSync(join(tmpdir(), "workflow-controller-owner-")),
    runner: runner as never,
  });
  expect(runner.registrations[0]?.parentSessionId).toBe("parent");
});

test("session shutdown preempts a workflow stuck after an await", async () => {
  const runner = new SubagentRunner();
  const script = `export const meta = { name: 'shutdown-loop', description: 'test' };
await Promise.resolve();
while (true) {}`;
  const startedAt = Date.now();
  const execution = runWorkflow({ script }, parent, {
    rootDir: mkdtempSync(join(tmpdir(), "workflow-shutdown-loop-")),
    runner,
  });
  // Attach a plain rejection handler before disposal. Bun's rejects matcher
  // pumps the promise before returning, which would delay the abort itself.
  const outcome = execution.then(() => undefined, (error: unknown) => error);
  await runner.disposeForSession("parent");
  const error = await outcome;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("Workflow stopped");
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});

test("a stale log callback cannot fail a workflow with an outstanding child", async () => {
  const runner = new FakeRunner();
  runner.resultFactory = async (spec, number) => {
    await Bun.sleep(20);
    return fakeResult(spec, number);
  };
  const script = `export const meta = { name: 'callback-failure', description: 'test' };
agent('slow');
log('trigger host callback');
return 'unreachable';`;

  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await runWorkflow({ script }, parent, {
      rootDir: mkdtempSync(join(tmpdir(), "workflow-callback-failure-")),
      runner: runner as never,
      onLog: () => { throw new Error("host log failed"); },
    });
    expect(result.result).toBe("unreachable");
  } finally {
    errorLog.mockRestore();
  }
});
