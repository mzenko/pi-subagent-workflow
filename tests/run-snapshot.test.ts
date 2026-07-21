import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunOwnership, type RunOwnership } from "../src/store/lease.js";
import { encodeCwd, RunStore } from "../src/store/run-store.js";
import { readRunSnapshot } from "../src/store/run-snapshot.js";
import { readRunDetail, readRunSummary, type RunSummary } from "../src/ui/navigator/store-read.js";
import { findLatestCompletedWorkflowRun, findWorkflowRunById } from "../src/workflow/saved.js";

const CWD = "/work/run-snapshot";
const DIRECTORY_TIME = new Date("2026-07-01T00:00:00.000Z");

type OwnerVariant = "missing" | "live" | "stale" | "malformed-live";

interface Fixture {
  runId: string;
  createdAt: string;
  kind?: "subagent" | "workflow";
  runText?: string;
  statusText?: string;
  events?: string[];
  generationPending?: boolean;
  owner?: OwnerVariant;
  expectedDiagnostics: Array<{ file: string; line?: number }>;
  expectedEvents?: number;
  expectedPending?: boolean;
  expectedOwner: "missing" | "valid" | "malformed";
  expectedSummary: Omit<RunSummary, "runId" | "runDir">;
  savedEligible: boolean;
}

const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 1,
});

function record(runId: string, createdAt: string, kind: "subagent" | "workflow" = "workflow"): object {
  return {
    runId,
    kind,
    createdAt,
    children: [{ id: "child", spec: { prompt: "fixture child", label: "Runner" } }],
  };
}

function status(runStatus: "running" | "completed", childStatus = runStatus): object {
  return {
    status: runStatus,
    children: { child: { status: childStatus, usage: usage(runStatus === "running" ? 4 : 10, runStatus === "running" ? 2 : 5) } },
  };
}

const fixtures: Fixture[] = [
  {
    runId: "workflow-completed-a",
    createdAt: "2026-07-01T01:00:00.000Z",
    expectedDiagnostics: [],
    expectedOwner: "missing",
    expectedSummary: {
      kind: "workflow", createdAt: 1_782_867_600_000, label: "workflow", fanout: false,
      status: "completed", done: 1, total: 1, completed: 1, failed: 0, aborted: 0, tokens: 15, corrupt: false, reconciled: false,
    },
    savedEligible: true,
  },
  {
    runId: "run-running-a",
    createdAt: "2026-07-01T02:00:00.000Z",
    kind: "subagent",
    owner: "live",
    statusText: JSON.stringify(status("running")),
    expectedDiagnostics: [],
    expectedOwner: "valid",
    expectedSummary: {
      kind: "subagent", createdAt: 1_782_871_200_000, label: "Runner", fanout: false,
      status: "running", done: 0, total: 1, completed: 0, failed: 0, aborted: 0, tokens: 6, corrupt: false, reconciled: false,
    },
    savedEligible: false,
  },
  {
    runId: "workflow-torn-a",
    createdAt: "2026-07-01T03:00:00.000Z",
    statusText: "{\"status\":\"running\"",
    events: [JSON.stringify({
      timestamp: "2026-07-01T03:01:00.000Z",
      type: "result",
      id: "child",
      result: { status: "completed", usage: usage(3, 2) },
    })],
    expectedDiagnostics: [{ file: "status.json" }],
    expectedEvents: 1,
    expectedOwner: "missing",
    expectedSummary: {
      kind: "workflow", createdAt: 1_782_874_800_000, label: "workflow", fanout: false,
      status: "aborted", done: 1, total: 1, completed: 1, failed: 0, aborted: 0, tokens: 5, corrupt: false, reconciled: true,
    },
    savedEligible: false,
  },
  {
    runId: "workflow-corrupt-a",
    createdAt: "2026-07-01T04:00:00.000Z",
    runText: "{broken",
    expectedDiagnostics: [{ file: "run.json" }],
    expectedOwner: "missing",
    expectedSummary: {
      kind: "subagent", createdAt: 1_782_864_000_000, label: "unreadable run", fanout: false,
      status: "failed", done: 0, total: 0, completed: 0, failed: 0, aborted: 0, tokens: 0, corrupt: true, reconciled: false,
    },
    savedEligible: false,
  },
  {
    runId: "workflow-events-a",
    createdAt: "2026-07-01T05:00:00.000Z",
    statusText: JSON.stringify({
      status: "completed",
      children: { child: { status: "completed", usage: usage(2, 1) } },
    }),
    events: [
      JSON.stringify({ timestamp: "2026-07-01T05:01:00.000Z", type: "log", message: "before" }),
      "{garbage",
      JSON.stringify({ timestamp: "2026-07-01T05:02:00.000Z", type: "result", id: "child", result: { status: "completed", usage: usage(2, 1) } }),
      "not-json",
      JSON.stringify({ timestamp: "2026-07-01T05:03:00.000Z", type: "log", message: "after" }),
    ],
    expectedDiagnostics: [
      { file: "events.jsonl", line: 2 },
      { file: "events.jsonl", line: 4 },
    ],
    expectedEvents: 3,
    expectedOwner: "missing",
    expectedSummary: {
      kind: "workflow", createdAt: 1_782_882_000_000, label: "workflow", fanout: false,
      status: "completed", done: 1, total: 1, completed: 1, failed: 0, aborted: 0, tokens: 3, corrupt: false, reconciled: false,
    },
    savedEligible: true,
  },
  {
    runId: "workflow-pending-a",
    createdAt: "2026-07-01T06:00:00.000Z",
    generationPending: true,
    expectedDiagnostics: [],
    expectedPending: true,
    expectedOwner: "missing",
    expectedSummary: {
      kind: "subagent", createdAt: 1_782_864_000_000, label: "quarantined - crashed mid-resume", fanout: false,
      status: "failed", done: 0, total: 0, completed: 0, failed: 0, aborted: 0, tokens: 0, corrupt: true, reconciled: false,
    },
    savedEligible: false,
  },
  {
    runId: "workflow-owner-a",
    createdAt: "2026-07-01T07:00:00.000Z",
    owner: "stale",
    statusText: JSON.stringify(status("running")),
    expectedDiagnostics: [],
    expectedOwner: "valid",
    expectedSummary: {
      kind: "workflow", createdAt: 1_782_889_200_000, label: "workflow", fanout: false,
      status: "aborted", done: 1, total: 1, completed: 0, failed: 0, aborted: 1, tokens: 6, corrupt: false, reconciled: true,
    },
    savedEligible: false,
  },
  {
    runId: "workflow-owner-b",
    createdAt: "2026-07-01T08:00:00.000Z",
    owner: "malformed-live",
    statusText: JSON.stringify(status("running")),
    expectedDiagnostics: [{ file: "owner.json" }],
    expectedOwner: "malformed",
    expectedSummary: {
      kind: "workflow", createdAt: 1_782_892_800_000, label: "workflow", fanout: false,
      status: "running", done: 0, total: 1, completed: 0, failed: 0, aborted: 0, tokens: 6, corrupt: false, reconciled: false,
    },
    savedEligible: false,
  },
];

function writeFixture(root: string, fixture: Fixture): { runDir: string; ownership?: RunOwnership } {
  const runDir = join(root, encodeCwd(CWD), fixture.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), fixture.runText ?? JSON.stringify(record(fixture.runId, fixture.createdAt, fixture.kind)));
  writeFileSync(join(runDir, "status.json"), fixture.statusText ?? JSON.stringify(status("completed")));
  writeFileSync(join(runDir, "events.jsonl"), (fixture.events ?? []).join("\n"));
  writeFileSync(join(runDir, "script.js"), "return 1;\n");
  writeFileSync(join(runDir, "args.json"), JSON.stringify({ fixture: fixture.runId }));
  if (fixture.generationPending) writeFileSync(join(runDir, "generation.pending"), "{}\n");
  if (fixture.owner === "stale") {
    writeFileSync(join(runDir, "owner.json"), JSON.stringify({
      v: 1,
      pid: 4242,
      host: "stale-host",
      startedAt: "2026-07-01T00:00:00.000Z",
    }));
  }
  const ownership = fixture.owner === "live" || fixture.owner === "malformed-live"
    ? acquireRunOwnership(runDir)
    : undefined;
  if (fixture.owner === "malformed-live") writeFileSync(join(runDir, "owner.json"), "{broken");
  utimesSync(runDir, DIRECTORY_TIME, DIRECTORY_TIME);
  return { runDir, ownership };
}

function comparableSummary(summary: RunSummary): Omit<RunSummary, "runId" | "runDir"> {
  const { runId: _runId, runDir: _runDir, ...value } = summary;
  return value;
}

test("snapshot diagnostics and consumer projections preserve captured fixture behavior", () => {
  const root = mkdtempSync(join(tmpdir(), "run-snapshot-"));
  const owned: RunOwnership[] = [];
  try {
    for (const fixture of fixtures) {
      const { runDir, ownership } = writeFixture(root, fixture);
      if (ownership) owned.push(ownership);
      const snapshot = readRunSnapshot(runDir);

      expect(snapshot.diagnostics.map(({ file, line }) => ({ file, ...(line === undefined ? {} : { line }) })))
        .toEqual(fixture.expectedDiagnostics);
      expect(snapshot.diagnostics.every((diagnostic) => diagnostic.problem.length > 0)).toBe(true);
      expect(snapshot.events).toHaveLength(fixture.expectedEvents ?? 0);
      expect(snapshot.generationPending).toBe(fixture.expectedPending ?? false);
      if (fixture.expectedOwner === "valid") expect(snapshot.ownerMetadata).toBeDefined();
      else expect(snapshot.ownerMetadata).toBeUndefined();

      // These literals guard navigator and saved-run behavior across shared snapshot changes.
      expect(comparableSummary(readRunSummary(runDir, fixture.runId))).toEqual(fixture.expectedSummary);
      expect(findWorkflowRunById(CWD, fixture.runId, root) !== undefined).toBe(fixture.savedEligible);
    }
  } finally {
    for (const ownership of owned.reverse()) ownership.release();
  }
});

test("run snapshots deeply freeze parsed values and diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "run-snapshot-frozen-"));
  const fixture = fixtures[4]!;
  const { runDir } = writeFixture(root, fixture);
  writeFileSync(join(runDir, "owner.json"), JSON.stringify({ nested: { value: 1 } }));
  const snapshot = readRunSnapshot(runDir);
  const recordValue = snapshot.record as { children: readonly unknown[] };
  const statusValue = snapshot.status as { children: object };
  const resultEvent = snapshot.events[1] as { result: { usage: object } };
  const ownerValue = snapshot.ownerMetadata as { nested: object };

  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.events)).toBe(true);
  expect(Object.isFrozen(snapshot.diagnostics)).toBe(true);
  expect(Object.isFrozen(snapshot.diagnostics[0]!)).toBe(true);
  expect(Object.isFrozen(snapshot.record!)).toBe(true);
  expect(Object.isFrozen(recordValue.children)).toBe(true);
  expect(Object.isFrozen(snapshot.status!)).toBe(true);
  expect(Object.isFrozen(statusValue.children)).toBe(true);
  expect(Object.isFrozen(snapshot.events[0]!)).toBe(true);
  expect(Object.isFrozen(resultEvent.result)).toBe(true);
  expect(Object.isFrozen(resultEvent.result.usage)).toBe(true);
  expect(Object.isFrozen(snapshot.ownerMetadata!)).toBe(true);
  expect(Object.isFrozen(ownerValue.nested)).toBe(true);
});

test("missing required files are diagnostics rather than thrown errors", () => {
  const runDir = join(mkdtempSync(join(tmpdir(), "run-snapshot-missing-")), "absent");
  const snapshot = readRunSnapshot(runDir);

  expect(snapshot.record).toBeUndefined();
  expect(snapshot.status).toBeUndefined();
  expect(snapshot.events).toEqual([]);
  expect(snapshot.generationPending).toBe(false);
  expect(snapshot.ownerMetadata).toBeUndefined();
  expect(snapshot.diagnostics.map((diagnostic) => diagnostic.file)).toEqual([
    "run.json",
    "status.json",
    "events.jsonl",
  ]);
  expect(snapshot.diagnostics.every((diagnostic) => diagnostic.problem.includes("ENOENT"))).toBe(true);
});

test("each snapshot call observes current disk state without caching", () => {
  const root = mkdtempSync(join(tmpdir(), "run-snapshot-no-cache-"));
  const fixture = fixtures[0]!;
  const { runDir } = writeFixture(root, fixture);
  const first = readRunSnapshot(runDir);
  writeFileSync(join(runDir, "status.json"), JSON.stringify(status("running")));
  const second = readRunSnapshot(runDir);

  expect(second).not.toBe(first);
  expect((first.status as { status: string }).status).toBe("completed");
  expect((second.status as { status: string }).status).toBe("running");
});

test("snapshot re-reads stale run.json once when status references a new child", () => {
  const root = mkdtempSync(join(tmpdir(), "run-snapshot-stale-record-"));
  const fixture = fixtures[0]!;
  const { runDir } = writeFixture(root, fixture);
  const staleRecord = record(fixture.runId, fixture.createdAt);
  const currentRecord = {
    ...staleRecord,
    children: [
      { id: "child", spec: { prompt: "fixture child", label: "Runner" } },
      { id: "new-child", spec: { prompt: "new child", label: "New runner" } },
    ],
  };
  writeFileSync(join(runDir, "status.json"), JSON.stringify({
    status: "running",
    children: {
      child: { status: "completed", usage: usage(10, 5) },
      "new-child": { status: "running", usage: usage(4, 2) },
    },
  }));
  let recordReads = 0;

  const snapshot = readRunSnapshot(runDir, (path) => {
    if (path !== join(runDir, "run.json")) return readFileSync(path, "utf8");
    recordReads += 1;
    if (recordReads === 2) writeFileSync(join(runDir, "generation.pending"), "{}\n");
    return JSON.stringify(recordReads === 1 ? staleRecord : currentRecord);
  });

  expect(recordReads).toBe(2);
  expect((snapshot.record as { children: Array<{ id: string }> }).children.map((child) => child.id))
    .toEqual(["child", "new-child"]);
  expect(snapshot.rawRecord).toBe(JSON.stringify(currentRecord));
  expect(snapshot.diagnostics).toEqual([]);
  expect(snapshot.generationPending).toBe(true);
});

test("snapshot reports a generation marker removed during the read", () => {
  const root = mkdtempSync(join(tmpdir(), "run-snapshot-marker-removal-"));
  const fixture = fixtures[0]!;
  const { runDir } = writeFixture(root, fixture);
  const markerPath = join(runDir, "generation.pending");
  writeFileSync(markerPath, "{}\n");
  let removed = false;

  const snapshot = readRunSnapshot(runDir, (path) => {
    if (!removed) {
      removed = true;
      unlinkSync(markerPath);
    }
    return readFileSync(path, "utf8");
  });

  expect(removed).toBe(true);
  expect(snapshot.generationPending).toBe(true);
});

test("snapshot re-reads stale run.json once when only events reference a new child", () => {
  const root = mkdtempSync(join(tmpdir(), "run-snapshot-stale-record-event-"));
  const fixture = fixtures[0]!;
  const { runDir } = writeFixture(root, fixture);
  const staleRecord = record(fixture.runId, fixture.createdAt);
  const currentRecord = {
    ...staleRecord,
    children: [
      { id: "child", spec: { prompt: "fixture child", label: "Runner" } },
      { id: "event-child", spec: { prompt: "event child", label: "Event runner" } },
    ],
  };
  writeFileSync(join(runDir, "events.jsonl"), JSON.stringify({
    timestamp: "2026-07-01T01:01:00.000Z",
    type: "child_added",
    id: "event-child",
  }));
  let recordReads = 0;

  const snapshot = readRunSnapshot(runDir, (path) => {
    if (path !== join(runDir, "run.json")) return readFileSync(path, "utf8");
    recordReads += 1;
    return JSON.stringify(recordReads === 1 ? staleRecord : currentRecord);
  });

  expect(recordReads).toBe(2);
  expect((snapshot.record as { children: Array<{ id: string }> }).children.map((child) => child.id))
    .toEqual(["child", "event-child"]);
  expect(snapshot.diagnostics).toEqual([]);
});

test("snapshot diagnoses a persistently incoherent run.json after one retry", () => {
  const root = mkdtempSync(join(tmpdir(), "run-snapshot-incoherent-record-"));
  const fixture = fixtures[0]!;
  const { runDir } = writeFixture(root, fixture);
  writeFileSync(join(runDir, "status.json"), JSON.stringify({
    status: "running",
    children: {
      child: { status: "completed", usage: usage(10, 5) },
      orphan: { status: "running", usage: usage(4, 2) },
    },
  }));
  let recordReads = 0;

  const snapshot = readRunSnapshot(runDir, (path) => {
    if (path === join(runDir, "run.json")) recordReads += 1;
    return readFileSync(path, "utf8");
  });

  expect(recordReads).toBe(2);
  expect(snapshot.diagnostics).toEqual([{
    file: "run.json",
    problem: "run.json still omits child IDs referenced by status.json or events.jsonl after retry",
  }]);
});

test("script presence retains existsSync semantics for symlink loops", () => {
  const root = mkdtempSync(join(tmpdir(), "run-snapshot-script-loop-"));
  const fixture = fixtures[0]!;
  const { runDir } = writeFixture(root, fixture);
  const scriptPath = join(runDir, "script.js");
  unlinkSync(scriptPath);
  symlinkSync("script.js", scriptPath);

  const snapshot = readRunSnapshot(runDir);
  expect(snapshot.scriptPresent).toBe(false);
  expect(snapshot.diagnostics.some((diagnostic) => diagnostic.file === "script.js" && diagnostic.problem.includes("ELOOP"))).toBe(true);
  expect(readRunDetail(runDir, fixture.runId).hasScript).toBe(false);
  expect(findWorkflowRunById(CWD, fixture.runId, root)).toBeUndefined();
  expect(findLatestCompletedWorkflowRun(CWD, root)).toBeUndefined();
});

test("resume refuses malformed event history without changing it", () => {
  const root = mkdtempSync(join(tmpdir(), "run-snapshot-resume-events-"));
  const runId = "workflow-raw-a";
  const first = new RunStore(runId, CWD, "parent-a", undefined, { rootDir: root, kind: "workflow" });
  first.startWorkflowGeneration("return 1;\n", undefined);
  first.workflowFinished("completed");
  appendFileSync(join(first.runDir, "events.jsonl"), "{malformed-event\n");
  const beforeResume = readFileSync(join(first.runDir, "events.jsonl"), "utf8");

  expect(() => new RunStore(runId, CWD, "parent-b", undefined, {
    existingRunDir: first.runDir,
    existingSnapshot: readRunSnapshot(first.runDir),
  })).toThrow("invalid events.jsonl line");
  expect(readFileSync(join(first.runDir, "events.jsonl"), "utf8")).toBe(beforeResume);
});

test("resume refuses event history that the snapshot could not read", () => {
  const root = mkdtempSync(join(tmpdir(), "run-snapshot-unreadable-events-"));
  const runId = "workflow-unreadable-a";
  const first = new RunStore(runId, CWD, "parent-a", undefined, { rootDir: root, kind: "workflow" });
  first.startWorkflowGeneration("return 1;\n", undefined);
  first.workflowFinished("completed");
  const eventsPath = join(first.runDir, "events.jsonl");
  const beforeResume = readFileSync(eventsPath, "utf8");
  chmodSync(eventsPath, 0o200);

  try {
    expect(() => new RunStore(runId, CWD, "parent-b", undefined, {
      existingRunDir: first.runDir,
      existingSnapshot: readRunSnapshot(first.runDir),
    }))
      .toThrow("EACCES");
  } finally {
    chmodSync(eventsPath, 0o600);
  }

  const afterResume = readFileSync(eventsPath, "utf8");
  expect(afterResume).toBe(beforeResume);
});
