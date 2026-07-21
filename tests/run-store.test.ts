import { expect, spyOn, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_FILE, runOwnerIsLive } from "../src/store/lease.js";
import { encodeCwd, GenerationPendingError, RunStore, RunStoreOwnershipError, stageFileExclusive } from "../src/store/run-store.js";
import { readJournal } from "../src/workflow/journal.js";

interface RunStoreFileInternals {
  stageFile(path: string, content: string, options?: { durable?: boolean }): string;
  replaceStagedFile(temporary: string, path: string): void;
  syncRunDirectory(): void;
}

const runStoreFileInternals = RunStore.prototype as unknown as RunStoreFileInternals;
const PENDING_STARTED_AT = "2026-07-13T12:34:56.000Z";

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "subagent-run-store-"));
}

function createCompletedWorkflow(rootDir: string, runId: string): RunStore {
  const store = new RunStore(runId, "/work/example", "parent-1", undefined, {
    rootDir,
    kind: "workflow",
  });
  store.startWorkflowGeneration("old script", [{ title: "Old" }], {
    args: { value: { generation: 1 } },
  });
  store.workflowFinished("completed");
  expect(existsSync(join(store.runDir, "budget.json"))).toBe(false);
  return store;
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw");
}

function expectGenerationRefusal(runId: string, runDir: string): void {
  const error = captureError(() => new RunStore(runId, "/work/example", "parent-3", undefined, {
    existingRunDir: runDir,
    kind: "workflow",
  }));
  expect(error).toBeInstanceOf(GenerationPendingError);
  expect((error as Error).message).toBe(
    `Cannot resume run ${runId}: generation.pending was left by a previous generation commit that crashed, so the run is inconsistent and cannot be resumed. Re-run the workflow fresh; delete the run directory to clean it up: ${runDir}`,
  );
}

test("run store creates its layout and appends events", () => {
  const rootDir = temporaryRoot();
  const store = new RunStore("run-1", "/work/example", "parent-1", "/parent.jsonl", { rootDir });
  store.addChild("child-1", { prompt: "test" });
  store.recordEvent({ type: "status", id: "child-1", status: "running" });
  expect(readdirSync(store.runDir).sort()).toEqual([
    "events.jsonl",
    "owner.json",
    "owner.sqlite",
    "owner.sqlite-journal",
    "run.json",
    "sessions",
    "status.json",
  ]);
  expect(JSON.parse(readFileSync(join(store.runDir, "run.json"), "utf8"))).toMatchObject({
    v: 3,
    delivery: { protocol: 1, generation: 1 },
  });
  const events = readFileSync(join(store.runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events.map((event) => event.type)).toEqual(["created", "child_added", "status"]);
});

test("fresh run directories and persisted files are private", () => {
  const store = new RunStore("run-private", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  store.appendJournal({ private: true });
  expect(statSync(store.runDir).mode & 0o777).toBe(0o700);
  expect(statSync(store.sessionsDir).mode & 0o777).toBe(0o700);
  for (const name of ["run.json", "status.json", "events.jsonl", "journal.jsonl"]) {
    expect(statSync(join(store.runDir, name)).mode & 0o777).toBe(0o600);
  }
  store.releaseOwnership();
});

test("journal and event appends separate an unterminated JSON record", () => {
  const store = new RunStore("run-jsonl-boundary", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  const journalPath = join(store.runDir, "journal.jsonl");
  const eventsPath = join(store.runDir, "events.jsonl");
  writeFileSync(journalPath, JSON.stringify({ first: true }));
  writeFileSync(eventsPath, JSON.stringify({ timestamp: "before", type: "log", message: "first" }));

  store.appendJournal({ second: true });
  store.recordLog("second");

  expect(readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)))
    .toEqual([{ first: true }, { second: true }]);
  expect(readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).map((event) => event.message))
    .toEqual(["first", "second"]);
  store.releaseOwnership();
});

test("journal append persists a framed entry that replay reads back", () => {
  const store = new RunStore("run-journal-durable", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  const path = join(store.runDir, "journal.jsonl");
  const entry = {
    v: 4 as const,
    call: { scope: [], operation: 0 },
    hash: "durable",
    fingerprint: {
      version: 1,
      provider: "test",
      modelId: "tiny",
      thinkingLevel: "off",
      cwd: "/work/example",
      extensionTools: [],
      childExtensionExclusions: [],
    },
    result: { ok: true },
    childId: "child-1",
  };
  const originalSync = runStoreFileInternals.syncRunDirectory;
  let directorySyncs = 0;
  const syncSpy = spyOn(runStoreFileInternals, "syncRunDirectory").mockImplementation(function (this: RunStoreFileInternals) {
    directorySyncs += 1;
    originalSync.call(this);
  });

  try {
    store.appendJournal(entry);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(entry)}\n`);
    expect([...readJournal(path).entries.values()]).toEqual([entry]);
    expect(directorySyncs).toBe(1);
  } finally {
    syncSpy.mockRestore();
    store.releaseOwnership();
  }
});

test("workflow run store captures and reloads its immutable agent cap", () => {
  const rootDir = temporaryRoot();
  const first = new RunStore("workflow-policy", "/work/example", "parent-1", undefined, {
    rootDir,
    kind: "workflow",
    maxAgentsPerWorkflow: 37,
  });
  expect(first.maxAgentsPerWorkflow).toBe(37);
  expect(first.childCount).toBe(0);
  first.addChild("child-1", { prompt: "test" });
  expect(first.childCount).toBe(1);
  first.releaseOwnership();

  const resumed = new RunStore("workflow-policy", "/work/example", "parent-1", undefined, {
    rootDir,
    kind: "workflow",
    existingRunDir: first.runDir,
  });
  expect(resumed.maxAgentsPerWorkflow).toBe(37);
  expect(resumed.childCount).toBe(1);
  resumed.releaseOwnership();
});

test("declared workflow phases still persist each runtime transition", () => {
  const store = new RunStore("workflow-phase-events", "/work/example", "parent-1", undefined, {
    rootDir: temporaryRoot(),
    kind: "workflow",
    phases: [{ title: "Plan" }, { title: "Build" }],
  });
  store.recordPhase("Plan");
  store.recordLog("planning");
  store.recordPhase("Build");

  const events = readFileSync(join(store.runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events.map((event) => event.type)).toEqual(["created", "phase", "log", "phase"]);
  expect(JSON.parse(readFileSync(join(store.runDir, "run.json"), "utf8")).phases).toEqual([{ title: "Plan" }, { title: "Build" }]);
  store.releaseOwnership();
});

test("edited resume replaces the phase skeleton while retaining historical child groups", () => {
  const rootDir = temporaryRoot();
  const store = new RunStore("workflow-phase-resume", "/work/example", "parent-1", undefined, {
    rootDir,
    kind: "workflow",
    phases: [
      { title: "Historical", detail: "keep this metadata" },
      { title: "Removed" },
      { title: "Replaced", detail: "old detail" },
    ],
  });
  store.startWorkflowGeneration("old script", [
    { title: "Historical", detail: "keep this metadata" },
    { title: "Removed" },
    { title: "Replaced", detail: "old detail" },
  ], { args: { value: null } });
  store.addChild("historical", { prompt: "old", phase: "Historical" });
  store.addChild("missing-metadata", { prompt: "old", phase: "Ad hoc" });
  store.addChild("replaced", { prompt: "old", phase: "Replaced" });
  store.releaseOwnership();

  const runPath = join(store.runDir, "run.json");
  const record = JSON.parse(readFileSync(runPath, "utf8"));
  record.children.push({ id: "legacy", spec: { prompt: "old" }, phase: "Legacy" });
  writeFileSync(runPath, JSON.stringify(record));
  const resumed = new RunStore("workflow-phase-resume", "/work/example", "parent-1", undefined, {
    rootDir,
    kind: "workflow",
    existingRunDir: store.runDir,
  });

  resumed.startWorkflowGeneration("new script", [
    { title: "New", detail: "new declaration" },
    { title: "Replaced", detail: "new detail" },
  ], {}, { requireExistingScript: true });

  const run = JSON.parse(readFileSync(join(resumed.runDir, "run.json"), "utf8"));
  expect(run.phases).toEqual([
    { title: "New", detail: "new declaration" },
    { title: "Replaced", detail: "new detail" },
    { title: "Historical", detail: "keep this metadata" },
    { title: "Ad hoc" },
    { title: "Legacy" },
  ]);
  expect(readFileSync(join(resumed.runDir, "script.js"), "utf8")).toBe("new script");
  expect(readFileSync(join(resumed.runDir, "script.resumed-1.js"), "utf8")).toBe("old script");
  resumed.releaseOwnership();
});

test("exact and edited resume atomically abort inherited live children", () => {
  const rootDir = temporaryRoot();
  const runId = "workflow-resume-reconciles-live";
  const first = new RunStore(runId, "/work/example", "parent-1", undefined, {
    rootDir,
    kind: "workflow",
  });
  first.startWorkflowGeneration("old script", undefined, { args: { value: null } });
  first.addChild("pending-old", { prompt: "pending" });
  first.addChild("running-old", { prompt: "running" });
  first.recordEvent({ type: "status", id: "running-old", status: "running" });
  first.recordEvent({
    type: "usage",
    id: "running-old",
    usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, cost: 0.5, turns: 1 },
  });
  first.addChild("completed-old", { prompt: "completed" });
  first.recordEvent({ type: "status", id: "completed-old", status: "completed" });
  first.addChild("event-terminal-old", { prompt: "terminal event won the crash race" });
  first.recordEvent({ type: "status", id: "event-terminal-old", status: "running" });
  first.recordEvent({
    type: "usage",
    id: "event-terminal-old",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 },
  });
  first.addChild("status-terminal-old", { prompt: "status won the crash race" });
  first.recordEvent({ type: "status", id: "status-terminal-old", status: "running" });
  first.recordEvent({
    type: "usage",
    id: "status-terminal-old",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 },
  });
  first.releaseOwnership();

  // Reproduce the addChild crash boundary: run.json contains pending-old, but
  // status.json never received its entry.
  const statusPath = join(first.runDir, "status.json");
  const interruptedStatus = JSON.parse(readFileSync(statusPath, "utf8"));
  delete interruptedStatus.children["pending-old"];
  const statusTerminalUsage = { input: 11, output: 5, cacheRead: 3, cacheWrite: 2, cost: 1.1, turns: 3 };
  interruptedStatus.children["status-terminal-old"] = { status: "completed", usage: statusTerminalUsage };
  writeFileSync(statusPath, JSON.stringify(interruptedStatus));
  // Reproduce recordEvent's opposite crash boundary: the terminal event made
  // it to events.jsonl, but its following status.json replacement did not.
  const eventsPath = join(first.runDir, "events.jsonl");
  const terminalUsage = { input: 9, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.9, turns: 2 };
  writeFileSync(eventsPath, `${readFileSync(eventsPath, "utf8")}${JSON.stringify({
    timestamp: "2026-07-13T12:00:00.000Z",
    type: "result",
    id: "event-terminal-old",
    result: { id: "event-terminal-old", status: "completed", usage: terminalUsage },
  })}\n`);

  const exact = new RunStore(runId, "/work/example", "parent-2", undefined, {
    existingRunDir: first.runDir,
    kind: "workflow",
  });
  exact.startWorkflowGeneration("old script", undefined, {}, { requireExistingScript: true });
  let status = JSON.parse(readFileSync(join(first.runDir, "status.json"), "utf8"));
  expect(status.status).toBe("running");
  expect(status.children["pending-old"].status).toBe("aborted");
  expect(status.children["running-old"]).toEqual({
    status: "aborted",
    usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, cost: 0.5, turns: 1 },
  });
  expect(status.children["completed-old"].status).toBe("completed");
  expect(status.children["event-terminal-old"]).toEqual({ status: "completed", usage: terminalUsage });
  expect(status.children["status-terminal-old"]).toEqual({ status: "completed", usage: statusTerminalUsage });
  exact.addChild("running-exact", { prompt: "retry" });
  exact.recordEvent({ type: "status", id: "running-exact", status: "running" });
  exact.releaseOwnership();

  const edited = new RunStore(runId, "/work/example", "parent-3", undefined, {
    existingRunDir: first.runDir,
    kind: "workflow",
  });
  edited.startWorkflowGeneration("edited script", undefined, {}, { requireExistingScript: true });
  status = JSON.parse(readFileSync(join(first.runDir, "status.json"), "utf8"));
  expect(status.children["running-exact"].status).toBe("aborted");
  expect(Object.values(status.children).every((child: any) => child.status !== "pending" && child.status !== "running")).toBe(true);
  const events = readFileSync(join(first.runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const latestStart = events.map((event: { type?: string }) => event.type).lastIndexOf("workflow_started");
  expect(events[latestStart - 1]).toMatchObject({ type: "status", id: "running-exact", status: "aborted" });
  expect(events.some((event: any) => event.id === "event-terminal-old" && event.status === "aborted")).toBe(false);
  expect(events.some((event: any) => event.id === "status-terminal-old" && event.status === "aborted")).toBe(false);
  edited.releaseOwnership();
});

test("a generation directory barrier failure leaves the run quarantined", () => {
  const failure = Object.assign(new Error("injected directory storage failure"), { code: "EIO" });
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const failAt of [1, 2]) {
      const store = new RunStore(`workflow-generation-sync-failure-${failAt}`, "/work/example", "parent-1", undefined, {
        rootDir: temporaryRoot(),
        kind: "workflow",
      });
      const originalSync = runStoreFileInternals.syncRunDirectory;
      let calls = 0;
      const syncSpy = spyOn(runStoreFileInternals, "syncRunDirectory").mockImplementation(function (this: RunStoreFileInternals) {
        calls += 1;
        if (calls === failAt) throw failure;
        originalSync.call(this);
      });
      try {
        expect(() => store.startWorkflowGeneration("return 'done';", undefined)).toThrow(failure);
        expect(existsSync(join(store.runDir, "generation.pending"))).toBe(true);
      } finally {
        syncSpy.mockRestore();
        store.releaseOwnership();
      }
    }
  } finally {
    errorLog.mockRestore();
  }
});

test("a generation staging failure leaves the pending marker and refuses another resume", () => {
  const rootDir = temporaryRoot();
  const runId = "workflow-generation-stage-failure";
  const first = createCompletedWorkflow(rootDir, runId);
  const resumed = new RunStore(runId, "/work/example", "parent-2", undefined, {
    existingRunDir: first.runDir,
    kind: "workflow",
    now: () => new Date(PENDING_STARTED_AT),
  });
  const canonical = ["status.json", "script.js", "run.json", "args.json", "events.jsonl"] as const;
  const before = Object.fromEntries(canonical.map((name) => [name, readFileSync(join(first.runDir, name), "utf8")])) as Record<typeof canonical[number], string>;
  const primary = new Error("injected generation staging failure");
  const originalStage = runStoreFileInternals.stageFile;
  const stageSpy = spyOn(runStoreFileInternals, "stageFile").mockImplementation(function (this: RunStoreFileInternals, path, content, options) {
    if (path === join(first.runDir, "script.js")) throw primary;
    return originalStage.call(this, path, content, options);
  });
  const errorLog = spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(() => resumed.startWorkflowGeneration("new script", [{ title: "New" }], {
      args: { value: { generation: 2 } },
    }, { requireExistingScript: true })).toThrow(primary.message);
  } finally {
    stageSpy.mockRestore();
    errorLog.mockRestore();
  }

  expect(JSON.parse(readFileSync(join(first.runDir, "generation.pending"), "utf8"))).toEqual({
    v: 1,
    startedAt: PENDING_STARTED_AT,
    reason: "generation-commit",
  });
  for (const name of canonical) expect(readFileSync(join(first.runDir, name), "utf8")).toBe(before[name]);
  expect(existsSync(join(first.runDir, "script.resumed-1.js"))).toBe(false);
  expect(readdirSync(first.runDir).filter((name) => name.includes(".tmp-"))).toEqual([]);

  expect(() => new RunStore(runId, "/work/example", "parent-3", undefined, {
    existingRunDir: first.runDir,
    kind: "workflow",
  })).toThrow("active in another process");
  resumed.releaseOwnership();
  expectGenerationRefusal(runId, first.runDir);
});

test("a mid-generation rename failure keeps status running and refuses another resume", () => {
  const rootDir = temporaryRoot();
  const runId = "workflow-generation-rename-failure";
  const first = createCompletedWorkflow(rootDir, runId);
  const resumed = new RunStore(runId, "/work/example", "parent-2", undefined, {
    existingRunDir: first.runDir,
    kind: "workflow",
    now: () => new Date(PENDING_STARTED_AT),
  });
  const scriptPath = join(first.runDir, "script.js");
  const eventsBefore = readFileSync(join(first.runDir, "events.jsonl"), "utf8");
  const primary = new Error("injected generation rename failure");
  const originalReplace = runStoreFileInternals.replaceStagedFile;
  const replaceSpy = spyOn(runStoreFileInternals, "replaceStagedFile").mockImplementation(function (this: RunStoreFileInternals, temporary, path) {
    if (path === scriptPath) throw primary;
    originalReplace.call(this, temporary, path);
  });
  const errorLog = spyOn(console, "error").mockImplementation(() => {});

  try {
    expect(() => resumed.startWorkflowGeneration("new script", [{ title: "New" }], {
      args: { value: { generation: 2 } },
    }, { requireExistingScript: true })).toThrow(primary.message);
  } finally {
    replaceSpy.mockRestore();
    errorLog.mockRestore();
  }

  expect(JSON.parse(readFileSync(join(first.runDir, "generation.pending"), "utf8"))).toEqual({
    v: 1,
    startedAt: PENDING_STARTED_AT,
    reason: "generation-commit",
  });
  expect(JSON.parse(readFileSync(join(first.runDir, "status.json"), "utf8")).status).toBe("running");
  expect(readFileSync(scriptPath, "utf8")).toBe("old script");
  expect(readFileSync(join(first.runDir, "script.resumed-1.js"), "utf8")).toBe("old script");
  expect(readFileSync(join(first.runDir, "events.jsonl"), "utf8")).toBe(eventsBefore);
  expect(readdirSync(first.runDir).filter((name) => name.includes(".tmp-"))).toEqual([]);

  resumed.releaseOwnership();
  expectGenerationRefusal(runId, first.runDir);
});

test("successful generation commits remove the marker and allow later resumes", () => {
  const rootDir = temporaryRoot();
  const runId = "workflow-generation-success";
  const first = createCompletedWorkflow(rootDir, runId);
  expect(first.deliveryIdentity?.generation).toBe(1);
  expect(existsSync(join(first.runDir, "generation.pending"))).toBe(false);

  const resumed = new RunStore(runId, "/work/example", "parent-2", undefined, {
    existingRunDir: first.runDir,
    kind: "workflow",
  });
  resumed.startWorkflowGeneration("new script", [{ title: "New" }], {}, { requireExistingScript: true });
  expect(resumed.deliveryIdentity?.generation).toBe(2);
  expect(existsSync(join(first.runDir, "generation.pending"))).toBe(false);
  expect((resumed as unknown as { openedSnapshot?: unknown }).openedSnapshot).toBeUndefined();
  resumed.workflowFinished("completed");

  const resumedAgain = new RunStore(runId, "/work/example", "parent-3", undefined, {
    existingRunDir: first.runDir,
    kind: "workflow",
  });
  resumedAgain.startWorkflowGeneration("new script", [{ title: "New" }], {}, { requireExistingScript: true });
  expect(resumedAgain.deliveryIdentity?.generation).toBe(3);
  expect(existsSync(join(first.runDir, "generation.pending"))).toBe(false);
  resumedAgain.workflowFinished("completed");
});

test("successful generation syncs the run directory after marker creation and removal", () => {
  const store = new RunStore("workflow-generation-sync", "/work/example", "parent-1", undefined, {
    rootDir: temporaryRoot(),
    kind: "workflow",
  });
  const originalSync = runStoreFileInternals.syncRunDirectory;
  const originalStage = runStoreFileInternals.stageFile;
  const markerStates: boolean[] = [];
  const stagedDurability: boolean[] = [];
  const syncSpy = spyOn(runStoreFileInternals, "syncRunDirectory").mockImplementation(function (this: RunStoreFileInternals) {
    markerStates.push(existsSync(join(store.runDir, "generation.pending")));
    originalSync.call(this);
  });
  const stageSpy = spyOn(runStoreFileInternals, "stageFile").mockImplementation(function (this: RunStoreFileInternals, path, content, options) {
    stagedDurability.push(options?.durable === true);
    return originalStage.call(this, path, content, options);
  });

  try {
    store.startWorkflowGeneration("return 'done';", undefined);
    expect(stagedDurability.length).toBeGreaterThan(0);
    expect(stagedDurability.every(Boolean)).toBe(true);
    expect(markerStates).toEqual([true, true, false]);
    expect(existsSync(join(store.runDir, "generation.pending"))).toBe(false);
  } finally {
    stageSpy.mockRestore();
    syncSpy.mockRestore();
    store.releaseOwnership();
  }
});

test("workflow run store rejects a corrupt persisted agent cap with context", () => {
  const rootDir = temporaryRoot();
  const first = new RunStore("workflow-policy-corrupt", "/work/example", "parent-1", undefined, {
    rootDir,
    kind: "workflow",
    maxAgentsPerWorkflow: 37,
  });
  first.releaseOwnership();
  const runPath = join(first.runDir, "run.json");
  const record = JSON.parse(readFileSync(runPath, "utf8"));
  record.workflowPolicy = {};
  writeFileSync(runPath, JSON.stringify(record));

  expect(() => new RunStore("workflow-policy-corrupt", "/work/example", "parent-1", undefined, {
    rootDir,
    kind: "workflow",
    existingRunDir: first.runDir,
  })).toThrow("invalid run.json workflowPolicy; expected maxAgentsPerWorkflow");
});

test("status replacement is atomic and leaves no temporary file", () => {
  const store = new RunStore("run-2", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  store.addChild("child-1", { prompt: "test" });
  store.recordEvent({ type: "status", id: "child-1", status: "completed" });
  const status = JSON.parse(readFileSync(join(store.runDir, "status.json"), "utf8"));
  expect(status.status).toBe("completed");
  expect(readdirSync(store.runDir).some((name) => name.startsWith("status.json.tmp-"))).toBe(false);
});

test("a partial staging write preserves its error and leaves no temporary file", () => {
  const directory = temporaryRoot();
  const path = join(directory, "journal.jsonl");
  const primary = new Error("injected partial write");
  let flags: string | undefined;
  let attempted = false;
  let caught: unknown;

  try {
    stageFileExclusive(path, "complete journal contents", {
      open: (temporary, openFlags, mode) => {
        flags = openFlags;
        return openSync(temporary, openFlags, mode);
      },
      write: (fd, buffer, offset, length) => {
        if (attempted) return writeSync(fd, buffer, offset, length);
        attempted = true;
        writeSync(fd, buffer, offset, Math.max(1, Math.floor(length / 2)));
        throw primary;
      },
      close: (fd) => {
        closeSync(fd);
        throw new Error("injected close failure");
      },
      remove: (temporary) => {
        rmSync(temporary, { force: true });
        throw new Error("injected cleanup failure");
      },
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(primary);
  expect(flags).toBe("wx");
  expect(readdirSync(directory).filter((name) => name.startsWith("journal.jsonl.tmp-"))).toEqual([]);
});

test("cwd encoding is readable and injective across paths that share a slug", () => {
  expect(encodeCwd("/home/me/project")).toMatch(/^--home-me-project--[0-9a-f]{16}$/);
  // These three all slug to "tmp-a-b"; the hash suffix keeps their run
  // directories distinct so runs never leak across projects.
  const collidable = [encodeCwd("/tmp/a/b"), encodeCwd("/tmp/a-b"), encodeCwd("/tmp/a:b")];
  expect(new Set(collidable).size).toBe(3);
  // Stable for a given path.
  expect(encodeCwd("/tmp/a/b")).toBe(encodeCwd("/tmp/a/b"));
});

test("initial persistence failure is fail-closed", () => {
  const impossibleRoot = join(temporaryRoot(), "file");
  writeFileSync(impossibleRoot, "not a directory");
  expect(() => new RunStore("run-3", "/work/example", "parent-1", undefined, { rootDir: impossibleRoot })).toThrow();
});

test("a new-store run id collision preserves the existing run metadata", () => {
  const rootDir = temporaryRoot();
  const first = new RunStore("run-collision", "/work/example", "parent-1", undefined, { rootDir });
  const runPath = join(first.runDir, "run.json");
  const statusPath = join(first.runDir, "status.json");
  const ownerPath = join(first.runDir, OWNER_FILE);
  const before = {
    run: readFileSync(runPath, "utf8"),
    status: readFileSync(statusPath, "utf8"),
    owner: readFileSync(ownerPath, "utf8"),
  };

  expect(() => new RunStore("run-collision", "/work/example", "parent-2", undefined, { rootDir }))
    .toThrow("already exists");
  expect(readFileSync(runPath, "utf8")).toBe(before.run);
  expect(readFileSync(statusPath, "utf8")).toBe(before.status);
  expect(readFileSync(ownerPath, "utf8")).toBe(before.owner);
  first.releaseOwnership();
});

test("subagent runs hold ownership while live and release it when all children settle", () => {
  const store = new RunStore("run-owner", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  const ownerPath = join(store.runDir, OWNER_FILE);
  expect(existsSync(ownerPath)).toBe(true);
  expect(runOwnerIsLive(store.runDir)).toBe(true);
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  expect(owner).toMatchObject({ v: 1, pid: process.pid });
  store.addChild("c1", { prompt: "x" });
  store.recordEvent({ type: "status", id: "c1", status: "running" });
  expect(existsSync(ownerPath)).toBe(true);
  store.recordEvent({ type: "status", id: "c1", status: "completed" });
  expect(existsSync(ownerPath)).toBe(false);
  expect(runOwnerIsLive(store.runDir)).toBe(false);
});

test("a degraded terminal write still releases run ownership", () => {
  const store = new RunStore("run-terminal-degraded", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  store.addChild("c1", { prompt: "x" });
  store.recordEvent({ type: "status", id: "c1", status: "running" });
  const statusPath = join(store.runDir, "status.json");
  rmSync(statusPath);
  mkdirSync(statusPath);

  store.recordEvent({ type: "status", id: "c1", status: "completed" });

  expect(store.persistenceDegraded).toBeDefined();
  expect(existsSync(join(store.runDir, OWNER_FILE))).toBe(false);
  expect(runOwnerIsLive(store.runDir)).toBe(false);
});

test("a terminal status keeps late telemetry from reopening the run", () => {
  const store = new RunStore("run-terminal-closed", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  store.addChild("c1", { prompt: "x" });
  store.recordEvent({ type: "status", id: "c1", status: "running" });
  store.recordEvent({ type: "status", id: "c1", status: "completed" });

  const ownerPath = join(store.runDir, OWNER_FILE);
  const eventsPath = join(store.runDir, "events.jsonl");
  const before = readFileSync(eventsPath, "utf8");
  expect(existsSync(ownerPath)).toBe(false);
  store.recordEvent({ type: "usage", id: "c1", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } });
  expect(existsSync(ownerPath)).toBe(false);
  expect(readFileSync(eventsPath, "utf8")).toBe(before);
});

test("a released store cannot reacquire and overwrite a later owner's child", () => {
  const rootDir = temporaryRoot();
  const runId = "run-acquire-once";
  const storeA = new RunStore(runId, "/work/example", "parent-a", undefined, { rootDir });
  storeA.addChild("c1", { prompt: "first" });
  storeA.recordEvent({ type: "status", id: "c1", status: "completed" });

  const storeB = new RunStore(runId, "/work/example", "parent-b", undefined, {
    existingRunDir: storeA.runDir,
  });
  storeB.addChild("c2", { prompt: "second" });
  storeB.recordEvent({ type: "status", id: "c2", status: "completed" });

  const statusPath = join(storeA.runDir, "status.json");
  const runPath = join(storeA.runDir, "run.json");
  const eventsPath = join(storeA.runDir, "events.jsonl");
  const statusAfterB = readFileSync(statusPath, "utf8");
  const runAfterB = readFileSync(runPath, "utf8");
  const eventsAfterB = readFileSync(eventsPath, "utf8");
  expect(Object.keys(JSON.parse(statusAfterB).children)).toEqual(["c1", "c2"]);

  // This pending event was the former warm-reopen path. Store A still has a
  // stale one-child snapshot, but release permanently closed its write side.
  storeA.recordEvent({ type: "status", id: "c1", status: "pending" });
  expect(() => storeA.addChild("stale-c3", { prompt: "stale" }))
    .toThrow(RunStoreOwnershipError);

  expect(existsSync(join(storeA.runDir, OWNER_FILE))).toBe(false);
  expect(readFileSync(statusPath, "utf8")).toBe(statusAfterB);
  expect(readFileSync(runPath, "utf8")).toBe(runAfterB);
  expect(readFileSync(eventsPath, "utf8")).toBe(eventsAfterB);
  expect(JSON.parse(readFileSync(statusPath, "utf8")).children.c2.status).toBe("completed");
});

test("post-release disposal telemetry never reacquires a completed run", () => {
  const store = new RunStore("run-post-release", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  store.addChild("c1", { prompt: "x" });
  store.recordEvent({ type: "status", id: "c1", status: "completed" });
  const ownerPath = join(store.runDir, OWNER_FILE);
  const eventsPath = join(store.runDir, "events.jsonl");
  const before = readFileSync(eventsPath, "utf8");

  store.disposed();
  store.recordEvent({ type: "usage", id: "c1", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } });
  store.recordEvent({ type: "activity", id: "c1", description: "late activity" });

  expect(existsSync(ownerPath)).toBe(false);
  expect(readFileSync(eventsPath, "utf8")).toBe(before);
});

test("workflow runs stay running between children and ignore pending events after completion", () => {
  const store = new RunStore("workflow-owner", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot(), kind: "workflow" });
  const ownerPath = join(store.runDir, OWNER_FILE);
  const statusPath = join(store.runDir, "status.json");
  const eventsPath = join(store.runDir, "events.jsonl");
  store.addChild("c1", { prompt: "x" });
  store.recordEvent({ type: "status", id: "c1", status: "completed" });
  // All children settled, but the workflow loop is still executing: the run
  // must not flap to completed (that would open a resume race window).
  expect(JSON.parse(readFileSync(statusPath, "utf8")).status).toBe("running");
  expect(existsSync(ownerPath)).toBe(true);
  expect(runOwnerIsLive(store.runDir)).toBe(true);
  store.workflowFinished("completed");
  expect(JSON.parse(readFileSync(statusPath, "utf8")).status).toBe("completed");
  expect(existsSync(ownerPath)).toBe(false);

  const closedStatus = readFileSync(statusPath, "utf8");
  const closedEvents = readFileSync(eventsPath, "utf8");
  const closedMemory = JSON.stringify((store as unknown as { status: unknown }).status);
  store.recordEvent({ type: "status", id: "c1", status: "pending" });
  expect(readFileSync(statusPath, "utf8")).toBe(closedStatus);
  expect(readFileSync(eventsPath, "utf8")).toBe(closedEvents);
  expect(JSON.stringify((store as unknown as { status: unknown }).status)).toBe(closedMemory);
  expect(existsSync(ownerPath)).toBe(false);
});

test("reopening a run held by another live process is refused", () => {
  const rootDir = temporaryRoot();
  const store = new RunStore("run-held", "/work/example", "parent-1", undefined, { rootDir });
  expect(() => new RunStore("run-held", "/work/example", "parent-2", undefined, { existingRunDir: store.runDir }))
    .toThrow("active in another process");
  store.releaseOwnership();
  const reopened = new RunStore("run-held", "/work/example", "parent-2", undefined, { existingRunDir: store.runDir });
  expect(JSON.parse(readFileSync(join(reopened.runDir, OWNER_FILE), "utf8")).pid).toBe(process.pid);
  reopened.releaseOwnership();
});

test("a persistence failure after initialization marks the store degraded", () => {
  const store = new RunStore("run-degraded", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  expect(store.persistenceDegraded).toBeUndefined();
  rmSync(store.runDir, { recursive: true, force: true });
  store.recordLog("post-failure write");
  expect(store.persistenceDegraded).toBeDefined();
});

test("editing owner metadata neither transfers nor revokes OS-held ownership", () => {
  const store = new RunStore("workflow-metadata-only", "/work/example", "parent-1", undefined, {
    rootDir: temporaryRoot(),
    kind: "workflow",
  });
  const runPath = join(store.runDir, "run.json");
  const statusPath = join(store.runDir, "status.json");
  writeFileSync(join(store.runDir, OWNER_FILE), JSON.stringify({
    v: 1,
    pid: 4242,
    host: "metadata-only-host",
    startedAt: "2026-07-12T10:00:00.000Z",
  }));

  expect(() => new RunStore("workflow-metadata-only", "/work/example", "parent-2", undefined, {
    existingRunDir: store.runDir,
    kind: "workflow",
  })).toThrow("active in another process (pid 4242 on metadata-only-host)");

  store.addChild("allowed", { prompt: "still owned" });
  store.appendJournal({ owned: true });
  store.workflowFinished("completed");

  expect(JSON.parse(readFileSync(runPath, "utf8")).children.map((child: { id: string }) => child.id)).toEqual(["allowed"]);
  expect(JSON.parse(readFileSync(statusPath, "utf8")).status).toBe("completed");
  expect(readFileSync(join(store.runDir, "journal.jsonl"), "utf8")).toContain("owned");
  expect(existsSync(join(store.runDir, OWNER_FILE))).toBe(false);
});

test("rewriteJournal atomically replaces the journal contents", () => {
  const store = new RunStore("run-journal", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  store.appendJournal({ index: 0, hash: "a" });
  store.appendJournal({ index: 1, hash: "b" });
  store.appendJournal({ index: 2, hash: "c" });
  store.rewriteJournal([{ index: 0, hash: "a" }]);
  const path = join(store.runDir, "journal.jsonl");
  const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(lines).toEqual([{ index: 0, hash: "a" }]);
  expect(readdirSync(store.runDir).some((name) => name.startsWith("journal.jsonl.tmp-"))).toBe(false);
});

test("process death releases run ownership so the run can be resumed", async () => {
  const rootDir = temporaryRoot();
  const runId = "workflow-process-death";
  const cwd = "/work/example";
  const runStoreUrl = new URL("../src/store/run-store.ts", import.meta.url).href;
  const ownerCode = `
    import { writeFileSync } from "node:fs";
    import { RunStore } from ${JSON.stringify(runStoreUrl)};
    const rootDir = ${JSON.stringify(rootDir)};
    const store = new RunStore(${JSON.stringify(runId)}, ${JSON.stringify(cwd)}, "old-parent", undefined, {
      rootDir,
      kind: "workflow",
    });
    writeFileSync(rootDir + "/owner-ready", store.runDir);
    while (store.runDir) await Bun.sleep(5);
  `;
  const owner = Bun.spawn(["bun", "-e", ownerCode], { stdout: "ignore", stderr: "pipe" });
  try {
    await waitForStoreFiles([join(rootDir, "owner-ready")]);
    const runDir = readFileSync(join(rootDir, "owner-ready"), "utf8");
    expect(() => new RunStore(runId, cwd, "blocked-parent", undefined, {
      existingRunDir: runDir,
      kind: "workflow",
    })).toThrow("active in another process");

    owner.kill();
    await owner.exited;

    const resumed = new RunStore(runId, cwd, "new-parent", undefined, {
      existingRunDir: runDir,
      kind: "workflow",
    });
    expect(JSON.parse(readFileSync(join(runDir, OWNER_FILE), "utf8")).pid).toBe(process.pid);
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain('"type":"resumed"');
    resumed.releaseOwnership();
  } finally {
    owner.kill();
    await owner.exited;
  }
});

test("corrupt resume metadata reports its file and releases acquired ownership", () => {
  const rootDir = temporaryRoot();
  const store = new RunStore("run-corrupt", "/work/example", "parent-1", undefined, { rootDir });
  const runDir = store.runDir;
  store.addChild("c1", { prompt: "x" });
  store.recordEvent({ type: "status", id: "c1", status: "completed" });
  writeFileSync(join(runDir, "run.json"), "{broken");
  expect(() => new RunStore("run-corrupt", "/work/example", "parent-2", undefined, { existingRunDir: runDir }))
    .toThrow("invalid run.json");
  expect(existsSync(join(runDir, OWNER_FILE))).toBe(false);
  expect(runOwnerIsLive(runDir)).toBe(false);
});

test("resume refuses a status object without a children record", () => {
  const store = new RunStore("run-empty-status", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  const runDir = store.runDir;
  store.releaseOwnership();
  writeFileSync(join(runDir, "status.json"), "{}\n");

  expect(() => new RunStore("run-empty-status", "/work/example", "parent-2", undefined, { existingRunDir: runDir }))
    .toThrow("invalid status.json: expected valid run and child status with cumulative usage");
  expect(runOwnerIsLive(runDir)).toBe(false);
});

test("resume refuses malformed child state, cross-file IDs, and event logs", () => {
  for (const variant of ["usage", "status-only", "duplicate", "events"] as const) {
    const runId = `run-invalid-child-${variant}`;
    const store = new RunStore(runId, "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
    store.addChild("c1", { prompt: "x" });
    const runDir = store.runDir;
    store.releaseOwnership();
    const runPath = join(runDir, "run.json");
    const statusPath = join(runDir, "status.json");
    const record = JSON.parse(readFileSync(runPath, "utf8"));
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    if (variant === "usage") status.children.c1.usage.input = -1;
    if (variant === "status-only") status.children.ghost = status.children.c1;
    if (variant === "duplicate") record.children.push(record.children[0]);
    writeFileSync(runPath, JSON.stringify(record));
    writeFileSync(statusPath, JSON.stringify(status));
    if (variant === "events") writeFileSync(join(runDir, "events.jsonl"), "{broken\n");

    expect(() => new RunStore(runId, "/work/example", "parent-2", undefined, { existingRunDir: runDir }))
      .toThrow(variant === "usage"
        ? "invalid status.json"
        : variant === "duplicate"
          ? "child IDs must be unique"
          : variant === "status-only"
            ? "status.json references child"
            : "invalid events.jsonl line 1");
    expect(runOwnerIsLive(runDir)).toBe(false);
  }
});

test("resume refuses semantically invalid child events", () => {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
  const invalidEvents = [
    42,
    { timestamp: "not-a-date", type: "activity", id: "c1", description: "working" },
    { timestamp: "2026-07-14T12:00:00.000Z", type: "status", id: "c1", status: "not-a-status" },
    { timestamp: "2026-07-14T12:00:00.000Z", type: "result", id: "c1", result: { id: "other", status: "completed", usage } },
  ];
  for (const [index, event] of invalidEvents.entries()) {
    const runId = `run-invalid-event-${index}`;
    const store = new RunStore(runId, "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
    store.addChild("c1", { prompt: "x" });
    const runDir = store.runDir;
    store.releaseOwnership();
    const eventsPath = join(runDir, "events.jsonl");
    writeFileSync(eventsPath, `${readFileSync(eventsPath, "utf8")}${JSON.stringify(event)}\n`);

    expect(() => new RunStore(runId, "/work/example", "parent-2", undefined, { existingRunDir: runDir }))
      .toThrow("invalid events.jsonl event");
    expect(runOwnerIsLive(runDir)).toBe(false);
  }
});

test("resume refuses contradictory terminal child history", () => {
  const store = new RunStore("run-contradictory-events", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  store.addChild("c1", { prompt: "x" });
  const runDir = store.runDir;
  store.releaseOwnership();
  const eventsPath = join(runDir, "events.jsonl");
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
  const terminalEvents = [
    { timestamp: "2026-07-14T12:00:00.000Z", type: "result", id: "c1", result: { id: "c1", status: "completed", usage } },
    { timestamp: "2026-07-14T12:01:00.000Z", type: "status", id: "c1", status: "failed" },
  ];
  writeFileSync(eventsPath, `${readFileSync(eventsPath, "utf8")}${terminalEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);

  expect(() => new RunStore("run-contradictory-events", "/work/example", "parent-2", undefined, { existingRunDir: runDir }))
    .toThrow("contradictory lifecycle for child");
  expect(runOwnerIsLive(runDir)).toBe(false);
});

test("child IDs cannot collide with plain-object prototype keys", () => {
  const store = new RunStore("run-prototype-child", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  expect(() => store.addChild("__proto__", { prompt: "x" })).toThrow("safe object key");
  store.addChild("c1", { prompt: "x" });
  expect(() => store.addChild("c1", { prompt: "duplicate" })).toThrow("already exists in this run");
  const runDir = store.runDir;
  store.releaseOwnership();
  const runPath = join(runDir, "run.json");
  const record = JSON.parse(readFileSync(runPath, "utf8"));
  record.children[0].id = "constructor";
  writeFileSync(runPath, JSON.stringify(record));

  expect(() => new RunStore("run-prototype-child", "/work/example", "parent-2", undefined, { existingRunDir: runDir }))
    .toThrow("invalid run.json");
  expect(runOwnerIsLive(runDir)).toBe(false);
});

test("resume refuses run metadata whose id does not match its directory", () => {
  const store = new RunStore("run-id-match", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  const runDir = store.runDir;
  store.releaseOwnership();
  const runPath = join(runDir, "run.json");
  const record = JSON.parse(readFileSync(runPath, "utf8"));
  record.runId = "run-someone-else";
  writeFileSync(runPath, JSON.stringify(record));

  expect(() => new RunStore("run-id-match", "/work/example", "parent-2", undefined, { existingRunDir: runDir }))
    .toThrow("invalid run.json: expected matching runId");
  expect(runOwnerIsLive(runDir)).toBe(false);
});

test("resume accepts a missing run.json version and refuses an unknown one", () => {
  const store = new RunStore("run-version", "/work/example", "parent-1", undefined, { rootDir: temporaryRoot() });
  const runDir = store.runDir;
  store.releaseOwnership();
  const runPath = join(runDir, "run.json");
  const record = JSON.parse(readFileSync(runPath, "utf8"));
  delete record.v;
  writeFileSync(runPath, JSON.stringify(record));

  const legacy = new RunStore("run-version", "/work/example", "parent-2", undefined, { existingRunDir: runDir });
  legacy.releaseOwnership();

  record.v = 4;
  writeFileSync(runPath, JSON.stringify(record));

  expect(() => new RunStore("run-version", "/work/example", "parent-3", undefined, { existingRunDir: runDir }))
    .toThrow(TypeError);
  expect(runOwnerIsLive(runDir)).toBe(false);
});

async function waitForStoreFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!paths.every(existsSync)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${paths.join(", ")}`);
    await Bun.sleep(5);
  }
}

test("the journal-append failpoint kills the process only after the entry is durable", async () => {
  const rootDir = temporaryRoot();
  const runId = "workflow-crash-failpoint";
  const cwd = "/work/example";
  const runStoreUrl = new URL("../src/store/run-store.ts", import.meta.url).href;
  const entry = {
    v: 4,
    call: { scope: [], operation: 0 },
    hash: "durable-before-crash",
    fingerprint: {
      version: 1,
      provider: "test",
      modelId: "tiny",
      thinkingLevel: "off",
      cwd,
      extensionTools: [],
      childExtensionExclusions: [],
    },
    result: "done",
    childId: "child-1",
  };
  const code = `
    import { RunStore } from ${JSON.stringify(runStoreUrl)};
    const store = new RunStore(${JSON.stringify(runId)}, ${JSON.stringify(cwd)}, "parent-1", undefined, {
      rootDir: ${JSON.stringify(rootDir)},
      kind: "workflow",
    });
    store.appendJournal(${JSON.stringify(entry)});
    console.log("SURVIVED-THE-FAILPOINT");
  `;
  const child = Bun.spawn(["bun", "-e", code], {
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, PI_SUBAGENT_WORKFLOW_CRASH_AFTER_JOURNAL_APPEND: "1" },
  });
  let stdout: string;
  try {
    stdout = await new Response(child.stdout).text();
    await child.exited;
  } finally {
    child.kill();
    await child.exited;
  }

  expect(child.signalCode).toBe("SIGKILL");
  expect(stdout).not.toContain("SURVIVED-THE-FAILPOINT");
  const runDir = join(rootDir, encodeCwd(cwd), runId);
  const journal = readJournal(join(runDir, "journal.jsonl"));
  expect([...journal.entries.values()]).toEqual([entry as never]);
});
