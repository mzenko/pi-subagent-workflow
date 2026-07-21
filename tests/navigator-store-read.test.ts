import { afterAll, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { acquireRunOwnership, type RunOwnership } from "../src/store/lease.js";
import { encodeCwd } from "../src/store/run-store.js";
import { foldRunProjection, projectRunSnapshot } from "../src/store/run-projection.js";
import { readRunSnapshot, type RunSnapshot } from "../src/store/run-snapshot.js";
import { NavigatorModel } from "../src/ui/navigator/model.js";
import { listRunSummaries, readRunDetail, readRunSummary } from "../src/ui/navigator/store-read.js";

const CWD = "/proj/example";

interface FixtureRun {
  runId: string;
  runJson: unknown;
  statusJson?: unknown;
  events?: string[];
  script?: string;
  /** Hold the run's SQLite ownership transaction for the fixture lifetime. */
  liveOwner?: boolean;
  /** Leave reader metadata without a held lock, modeling a dead owner. */
  deadOwner?: boolean;
  /** Quarantine an otherwise-readable run after an interrupted generation commit. */
  generationPending?: boolean;
}

const liveOwners: RunOwnership[] = [];
afterAll(() => {
  for (const owner of liveOwners.splice(0)) owner.release();
});

function makeRoot(runs: FixtureRun[], corrupt: { runId: string } | undefined = undefined): string {
  const root = mkdtempSync(join(tmpdir(), "nav-runs-"));
  const dir = join(root, encodeCwd(CWD));
  mkdirSync(dir, { recursive: true });
  for (const run of runs) {
    const runDir = join(dir, run.runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify(run.runJson));
    if (run.statusJson) writeFileSync(join(runDir, "status.json"), JSON.stringify(run.statusJson));
    if (run.events) writeFileSync(join(runDir, "events.jsonl"), run.events.join("\n"));
    if (run.script) writeFileSync(join(runDir, "script.js"), run.script);
    if (run.generationPending) writeFileSync(join(runDir, "generation.pending"), JSON.stringify({ v: 1 }));
    if (run.deadOwner) {
      writeFileSync(join(runDir, "owner.json"), JSON.stringify({
        v: 1,
        pid: 4242,
        host: "dead-owner-host",
        startedAt: "2026-07-11T08:00:00.000Z",
      }));
    }
    if (run.liveOwner) liveOwners.push(acquireRunOwnership(runDir));
  }
  if (corrupt) {
    const runDir = join(dir, corrupt.runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), "{ this is not json");
  }
  return root;
}

test("lists runs newest-first, derives labels, tolerates corrupt dirs", () => {
  const root = makeRoot(
    [
      {
        runId: "workflow-old",
        runJson: { runId: "workflow-old", kind: "workflow", createdAt: "2026-07-11T10:00:00.000Z", children: [{ id: "c1", spec: { prompt: "a" }, phase: "plan" }, { id: "c2", spec: { prompt: "b" }, phase: "build" }] },
        statusJson: { status: "completed", children: { c1: { status: "completed", usage: { input: 100, output: 50 } }, c2: { status: "completed", usage: { input: 0, output: 0 } } } },
        script: "// meta name lives here",
      },
      {
        runId: "run-new",
        runJson: { runId: "run-new", kind: "subagent", createdAt: "2026-07-11T12:00:00.000Z", children: [{ id: "x1", spec: { prompt: "one", label: "Fetcher" } }, { id: "x2", spec: { prompt: "two" } }] },
        statusJson: { status: "running", children: { x1: { status: "running", usage: { input: 10, output: 5 } }, x2: { status: "pending", usage: { input: 0, output: 0 } } } },
        liveOwner: true,
      },
    ],
    { runId: "run-broken" },
  );

  const rows = listRunSummaries(CWD, { root, describeWorkflow: () => "nightly-report" });
  // Three rows: two valid + one corrupt.
  expect(rows).toHaveLength(3);
  // Newest createdAt first; corrupt directory (mtime ~now) may sort anywhere but must be flagged.
  const newIndex = rows.findIndex((r) => r.runId === "run-new");
  const oldIndex = rows.findIndex((r) => r.runId === "workflow-old");
  expect(newIndex).toBeLessThan(oldIndex);

  const workflow = rows[oldIndex]!;
  expect(workflow.kind).toBe("workflow");
  expect(workflow.label).toBe("nightly-report");
  expect(workflow.done).toBe(2);
  expect(workflow.tokens).toBe(150);

  const fanout = rows[newIndex]!;
  expect(fanout.fanout).toBe(true);
  expect(fanout.label).toBe("fan-out ×2");
  expect(fanout.status).toBe("running");

  const broken = rows.find((r) => r.runId === "run-broken")!;
  expect(broken.corrupt).toBe(true);
  expect(broken.label).toBe("unreadable run");
});

test("missing runs directory yields an empty list, never throws", () => {
  expect(listRunSummaries(CWD, { root: join(tmpdir(), "does-not-exist-xyz") })).toEqual([]);
});

test("owned runs render entirely from the runner projection", () => {
  const runId = "run-owned-projection";
  const root = makeRoot([{
    runId,
    runJson: {
      runId,
      kind: "subagent",
      createdAt: "2026-07-11T10:00:00.000Z",
      children: [{ id: "c1", spec: { prompt: "live work", label: "worker" } }],
    },
    statusJson: { status: "pending", children: { c1: { status: "pending" } } },
    events: [],
  }]);
  const runDir = join(root, encodeCwd(CWD), runId);
  const projection = projectRunSnapshot(readRunSnapshot(runDir), runId);
  foldRunProjection(projection, { type: "status", id: "c1", status: "running", timestamp: 10 });
  foldRunProjection(projection, { type: "activity", id: "c1", description: "read file", timestamp: 11 });
  foldRunProjection(projection, { type: "usage", id: "c1", usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, timestamp: 12 });
  const opts = {
    root,
    ownedProjection: (id: string) => id === runId ? projection : undefined,
    readSnapshot(): never { throw new Error("owned render read files"); },
    ownerIsLive(): never { throw new Error("owned render probed the lock"); },
  };

  expect(listRunSummaries(CWD, opts)[0]).toMatchObject({ runId, status: "running", tokens: 7 });
  expect(new NavigatorModel(CWD, opts).detail(runId).children[0]).toMatchObject({
    status: "running",
    activity: "read file",
    tokens: 7,
  });
});

test("a second list of 50 unchanged terminal runs performs no additional snapshot or file-content reads", () => {
  const root = makeRoot(Array.from({ length: 50 }, (_, index) => {
    const runId = `terminal-${index}`;
    return {
      runId,
      runJson: {
        runId,
        kind: "subagent",
        createdAt: new Date(Date.UTC(2026, 6, 11, 10, 0, index)).toISOString(),
        children: [],
      },
      statusJson: { status: "completed", children: {} },
      events: [],
    };
  }));
  let snapshotReads = 0;
  let fileReads = 0;
  const opts = {
    root,
    readSnapshot(runDir: string) {
      snapshotReads += 1;
      return readRunSnapshot(runDir, (path) => {
        fileReads += 1;
        return readFileSync(path, "utf8");
      });
    },
  };

  const first = listRunSummaries(CWD, opts);
  expect(first).toHaveLength(50);
  expect(snapshotReads).toBe(50);
  expect(fileReads).toBe(300);

  const second = listRunSummaries(CWD, opts);
  expect(second).toEqual(first);
  expect(snapshotReads).toBe(50);
  expect(fileReads).toBe(300);
});

test("summary reads traverse events once and do not retain full detail", () => {
  const runId = "summary-only";
  const root = makeRoot([{
    runId,
    runJson: {
      runId,
      kind: "workflow",
      createdAt: "2026-07-11T10:00:00.000Z",
      children: [{ id: "c1", spec: { prompt: "work" }, resolved: { modelId: "test/detail-model" } }],
      phases: [{ title: "detail-only" }],
    },
    statusJson: { status: "completed", children: { c1: { status: "completed", usage: { input: 1, output: 1 } } } },
    events: [JSON.stringify({ type: "result", id: "c1", result: { status: "completed", usage: { input: 2, output: 3 } } })],
  }]);
  const runDir = join(root, encodeCwd(CWD), runId);
  const persisted = readRunSnapshot(runDir);
  let eventTraversals = 0;
  let snapshotReads = 0;
  const summaryEvents = new Proxy([
    { type: "log", get message(): never { throw new Error("summary built narrator detail"); } },
    { type: "activity", id: "c1", get description(): never { throw new Error("summary built activity detail"); } },
    { type: "result", id: "c1", result: { status: "completed", usage: { input: 2, output: 3 } } },
  ], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) eventTraversals += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const summaryRecord = {
    runId,
    kind: "workflow",
    createdAt: "2026-07-11T10:00:00.000Z",
    children: [{
      id: "c1",
      spec: { prompt: "work" },
      get resolved(): never { throw new Error("summary built child detail"); },
    }],
    get phases(): never { throw new Error("summary built phase detail"); },
  };
  const opts = {
    readSnapshot(path: string): RunSnapshot {
      snapshotReads += 1;
      if (snapshotReads > 1) return readRunSnapshot(path);
      return {
        ...persisted,
        record: summaryRecord,
        events: summaryEvents,
      } as unknown as RunSnapshot;
    },
  };

  expect(readRunSummary(runDir, runId, opts)).toMatchObject({ status: "completed", tokens: 5 });
  expect(eventTraversals).toBe(1);
  expect(snapshotReads).toBe(1);

  expect(readRunDetail(runDir, runId, opts)).toMatchObject({
    phases: [{ title: "detail-only" }],
    children: [expect.objectContaining({ model: "detail-model", tokens: 5 })],
  });
  expect(snapshotReads).toBe(2);
});

test("a terminal file mtime bump causes exactly one snapshot reread", () => {
  const runId = "terminal-mtime";
  const root = makeRoot([{
    runId,
    runJson: { runId, kind: "subagent", createdAt: "2026-07-11T10:00:00.000Z", children: [] },
    statusJson: { status: "completed", children: {} },
    events: [],
  }]);
  let snapshotReads = 0;
  const opts = {
    root,
    readSnapshot(runDir: string) {
      snapshotReads += 1;
      return readRunSnapshot(runDir);
    },
  };

  expect(listRunSummaries(CWD, opts)[0]?.status).toBe("completed");
  expect(snapshotReads).toBe(1);
  const bumped = new Date(Date.now() + 60_000);
  utimesSync(join(root, encodeCwd(CWD), runId, "status.json"), bumped, bumped);
  expect(listRunSummaries(CWD, opts)[0]?.status).toBe("completed");
  expect(snapshotReads).toBe(2);
  expect(listRunSummaries(CWD, opts)[0]?.status).toBe("completed");
  expect(snapshotReads).toBe(2);
});

test("a same-mtime rewrite with a different size invalidates the projection", () => {
  const runId = "terminal-size-change";
  const root = makeRoot([{
    runId,
    runJson: { runId, kind: "subagent", createdAt: "2026-07-11T10:00:00.000Z", children: [] },
    statusJson: { status: "completed", children: {} },
    events: [],
  }]);
  const runDir = join(root, encodeCwd(CWD), runId);
  const statusPath = join(runDir, "status.json");
  const fixed = new Date("2026-07-11T12:00:00.000Z");
  utimesSync(statusPath, fixed, fixed);
  let snapshotReads = 0;
  const opts = {
    readSnapshot(path: string) {
      snapshotReads += 1;
      return readRunSnapshot(path);
    },
  };

  expect(readRunSummary(runDir, runId, opts).status).toBe("completed");
  writeFileSync(statusPath, `${JSON.stringify({ status: "completed", children: {} }, null, 2)}\n`);
  utimesSync(statusPath, fixed, fixed);
  expect(readRunSummary(runDir, runId, opts).status).toBe("completed");
  expect(snapshotReads).toBe(2);
});

test("a same-size rewrite with restored mtime invalidates through ctime", async () => {
  const runId = "terminal-ctime-change";
  const oldRecord = {
    runId,
    kind: "subagent",
    createdAt: "2026-07-11T10:00:00.000Z",
    children: [{ id: "c1", spec: { prompt: "work", label: "old-name" } }],
  };
  const newRecord = {
    ...oldRecord,
    children: [{ id: "c1", spec: { prompt: "work", label: "new-name" } }],
  };
  const root = makeRoot([{
    runId,
    runJson: oldRecord,
    statusJson: { status: "completed", children: { c1: { status: "completed" } } },
    events: [],
  }]);
  const runDir = join(root, encodeCwd(CWD), runId);
  const runPath = join(runDir, "run.json");
  const fixed = new Date("2026-07-11T12:00:00.000Z");
  utimesSync(runPath, fixed, fixed);
  let snapshotReads = 0;
  const opts = {
    readSnapshot(path: string) {
      snapshotReads += 1;
      return readRunSnapshot(path);
    },
  };

  expect(readRunSummary(runDir, runId, opts).label).toBe("old-name");
  const before = statSync(runPath, { bigint: true });
  const replacement = JSON.stringify(newRecord);
  expect(BigInt(Buffer.byteLength(replacement))).toBe(before.size);
  await Bun.sleep(2);
  writeFileSync(runPath, replacement);
  utimesSync(runPath, fixed, fixed);
  const after = statSync(runPath, { bigint: true });
  expect(after.mtimeNs).toBe(before.mtimeNs);
  expect(after.ctimeNs).not.toBe(before.ctimeNs);

  expect(readRunSummary(runDir, runId, opts).label).toBe("new-name");
  expect(snapshotReads).toBe(2);
});

test("disk projections use a 500-entry LRU and cache hits refresh recency", () => {
  const runs = Array.from({ length: 501 }, (_, index) => {
    const runId = `lru-${index.toString().padStart(3, "0")}`;
    return {
      runId,
      runJson: { runId, kind: "subagent", createdAt: "2026-07-11T10:00:00.000Z", children: [] },
      statusJson: { status: "completed", children: {} },
      events: [],
    };
  });
  const root = makeRoot(runs);
  const reads = new Map<string, number>();
  const opts = {
    readSnapshot(path: string) {
      const runId = basename(path);
      reads.set(runId, (reads.get(runId) ?? 0) + 1);
      return readRunSnapshot(path);
    },
  };
  const runDir = (index: number) => join(root, encodeCwd(CWD), runs[index]!.runId);
  try {
    for (let index = 0; index < 500; index += 1) {
      readRunSummary(runDir(index), runs[index]!.runId, opts);
    }
    readRunSummary(runDir(0), runs[0]!.runId, opts);
    readRunSummary(runDir(500), runs[500]!.runId, opts);

    readRunSummary(runDir(1), runs[1]!.runId, opts);
    readRunSummary(runDir(0), runs[0]!.runId, opts);
    expect(reads.get(runs[0]!.runId)).toBe(1);
    expect(reads.get(runs[1]!.runId)).toBe(2);
    expect(reads.get(runs[500]!.runId)).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    listRunSummaries(CWD, { root });
  }
});

test("owned runs release disk-cache capacity for newly listed non-owned runs", () => {
  const runs = Array.from({ length: 500 }, (_, index) => {
    const runId = `owned-capacity-${index.toString().padStart(3, "0")}`;
    return {
      runId,
      runJson: { runId, kind: "subagent", createdAt: "2026-07-11T10:00:00.000Z", children: [] },
      statusJson: { status: "completed", children: {} },
      events: [],
    };
  });
  const root = makeRoot(runs);
  const ownedIds = new Set<string>();
  const projections = new Map<string, ReturnType<typeof projectRunSnapshot>>();
  const reads = new Map<string, number>();
  const opts = {
    root,
    // Force the new non-owned run to enumerate before every owned directory.
    listRunIds: (runsDir: string) => readdirSync(runsDir).sort(),
    ownedProjection(runId: string) {
      return ownedIds.has(runId) ? projections.get(runId) : undefined;
    },
    readSnapshot(path: string) {
      const runId = basename(path);
      reads.set(runId, (reads.get(runId) ?? 0) + 1);
      const snapshot = readRunSnapshot(path);
      projections.set(runId, projectRunSnapshot(snapshot, runId));
      return snapshot;
    },
  };
  const runsDir = join(root, encodeCwd(CWD));
  try {
    for (const run of runs) readRunSummary(join(runsDir, run.runId), run.runId, opts);
    for (const run of runs) ownedIds.add(run.runId);

    // The new directory exists before any post-ownership list, so the first
    // scan meets a cache still full of stale entries for now-owned runs. The
    // listing seam forces the new run to enumerate FIRST, proving capacity is
    // freed by the owned prepass, not by enumeration order.
    const nonOwnedId = "a-new-non-owned";
    const nonOwnedDir = join(runsDir, nonOwnedId);
    mkdirSync(nonOwnedDir);
    writeFileSync(join(nonOwnedDir, "run.json"), JSON.stringify({
      runId: nonOwnedId,
      kind: "subagent",
      createdAt: "2026-07-11T11:00:00.000Z",
      children: [],
    }));
    writeFileSync(join(nonOwnedDir, "status.json"), JSON.stringify({ status: "completed", children: {} }));
    writeFileSync(join(nonOwnedDir, "events.jsonl"), "");

    expect(listRunSummaries(CWD, opts)).toHaveLength(501);
    expect(reads.get(nonOwnedId)).toBe(1);
    expect(listRunSummaries(CWD, opts)).toHaveLength(501);
    expect(reads.get(nonOwnedId)).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    listRunSummaries(CWD, { root });
  }
});

test("same-order 501-run list scans reread only the uncached overflow", () => {
  const runs = Array.from({ length: 501 }, (_, index) => {
    const runId = `scan-${index.toString().padStart(3, "0")}`;
    return {
      runId,
      runJson: { runId, kind: "subagent", createdAt: "2026-07-11T10:00:00.000Z", children: [] },
      statusJson: { status: "completed", children: {} },
      events: [],
    };
  });
  const root = makeRoot(runs);
  let snapshotReads = 0;
  const opts = {
    root,
    readSnapshot(path: string) {
      snapshotReads += 1;
      return readRunSnapshot(path);
    },
  };
  try {
    expect(listRunSummaries(CWD, opts)).toHaveLength(501);
    expect(snapshotReads).toBe(501);

    expect(listRunSummaries(CWD, opts)).toHaveLength(501);
    expect(snapshotReads).toBe(502);

    expect(listRunSummaries(CWD, opts)).toHaveLength(501);
    expect(snapshotReads).toBe(503);
  } finally {
    rmSync(root, { recursive: true, force: true });
    listRunSummaries(CWD, { root });
  }
});

test("listing a cwd removes vanished run directories from the projection cache", () => {
  const root = mkdtempSync(join(tmpdir(), "nav-cache-prune-"));
  const runsDir = join(root, encodeCwd(CWD));
  const runId = "vanished";
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  let snapshotReads = 0;
  const snapshot = (path: string): RunSnapshot => ({
    runDir: path,
    record: { runId, kind: "subagent", createdAt: "2026-07-11T10:00:00.000Z", children: [] },
    status: { status: "completed", children: {} },
    events: [],
    generationPending: false,
    ownerMetadata: undefined,
    rawRecord: undefined,
    rawStatus: undefined,
    rawEvents: undefined,
    script: undefined,
    scriptPresent: false,
    argsText: undefined,
    diagnostics: [],
  });
  const opts = {
    root,
    readSnapshot(path: string) {
      snapshotReads += 1;
      return snapshot(path);
    },
  };
  try {
    expect(readRunSummary(runDir, runId, opts).status).toBe("completed");
    rmSync(runDir, { recursive: true, force: true });
    expect(listRunSummaries(CWD, opts)).toEqual([]);
    mkdirSync(runDir);
    expect(readRunSummary(runDir, runId, opts).status).toBe("completed");
    expect(snapshotReads).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("touching only script.js invalidates a terminal workflow projection", () => {
  const runId = "workflow-script-fingerprint";
  const root = makeRoot([{
    runId,
    runJson: { runId, kind: "workflow", createdAt: "2026-07-11T10:00:00.000Z", children: [] },
    statusJson: { status: "completed", children: {} },
    events: [],
    script: "old-name",
  }]);
  const runDir = join(root, encodeCwd(CWD), runId);
  let snapshotReads = 0;
  const opts = {
    root,
    describeWorkflow: (script: string) => script.trim(),
    readSnapshot(path: string) {
      snapshotReads += 1;
      return readRunSnapshot(path);
    },
  };

  expect(readRunSummary(runDir, runId, opts).label).toBe("old-name");
  writeFileSync(join(runDir, "script.js"), "new-name");
  const bumped = new Date(Date.now() + 60_000);
  utimesSync(join(runDir, "script.js"), bumped, bumped);
  expect(readRunSummary(runDir, runId, opts).label).toBe("new-name");
  expect(snapshotReads).toBe(2);
});

test("an absolute cache key preserves a caller's relative runDir and mutable projection isolation", () => {
  const runId = "terminal-relative-path";
  const root = makeRoot([{
    runId,
    runJson: { runId, kind: "subagent", createdAt: "2026-07-11T10:00:00.000Z", children: [] },
    statusJson: { status: "completed", children: {} },
    events: [],
  }]);
  const relativeRunDir = relative(process.cwd(), join(root, encodeCwd(CWD), runId));
  const readPaths: string[] = [];
  const opts = {
    readSnapshot(runDir: string) {
      readPaths.push(runDir);
      return readRunSnapshot(runDir);
    },
  };

  const first = readRunSummary(relativeRunDir, runId, opts);
  expect(first.runDir).toBe(relativeRunDir);
  expect(readPaths).toEqual([relativeRunDir]);
  first.label = "caller mutation";

  const cached = readRunSummary(relativeRunDir, runId, opts);
  expect(cached).not.toBe(first);
  expect(cached.runDir).toBe(relativeRunDir);
  expect(cached.label).toBe("subagent");
  expect(readPaths).toEqual([relativeRunDir]);
});

test("a pre-read mtime key self-corrects after a core file changes during a snapshot", () => {
  const runId = "terminal-racing-append";
  const root = makeRoot([{
    runId,
    runJson: { runId, kind: "subagent", createdAt: "2026-07-11T10:00:00.000Z", children: [] },
    statusJson: { status: "completed", children: {} },
    events: [],
  }]);
  let snapshotReads = 0;
  const opts = {
    root,
    readSnapshot(runDir: string) {
      snapshotReads += 1;
      const snapshot = readRunSnapshot(runDir);
      if (snapshotReads === 1) {
        const eventsPath = join(runDir, "events.jsonl");
        appendFileSync(eventsPath, JSON.stringify({
          timestamp: "2026-07-11T10:00:01.000Z",
          type: "log",
          message: "landed after the snapshot",
        }));
        const bumped = new Date(Date.now() + 60_000);
        utimesSync(eventsPath, bumped, bumped);
      }
      return snapshot;
    },
  };

  expect(listRunSummaries(CWD, opts)[0]?.status).toBe("completed");
  expect(snapshotReads).toBe(1);
  expect(listRunSummaries(CWD, opts)[0]?.status).toBe("completed");
  expect(snapshotReads).toBe(2);
  expect(listRunSummaries(CWD, opts)[0]?.status).toBe("completed");
  expect(snapshotReads).toBe(2);
});

test("foreign live runs reread changed files immediately and reprobe ownership after one second", () => {
  const runId = "always-live";
  const root = makeRoot([{
    runId,
    runJson: {
      runId,
      kind: "subagent",
      createdAt: "2026-07-11T10:00:00.000Z",
      children: [{ id: "c1", spec: { prompt: "still working" } }],
    },
    statusJson: { status: "running", children: { c1: { status: "running" } } },
    events: [],
  }]);
  let snapshotReads = 0;
  let ownerProbes = 0;
  const opts = {
    root,
    readSnapshot(runDir: string) {
      snapshotReads += 1;
      return readRunSnapshot(runDir);
    },
    ownerIsLive() {
      ownerProbes += 1;
      return true;
    },
  };

  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    expect(listRunSummaries(CWD, opts)[0]?.status).toBe("running");
    expect(listRunSummaries(CWD, opts)[0]?.status).toBe("running");
    const statusPath = join(root, encodeCwd(CWD), runId, "status.json");
    writeFileSync(statusPath, JSON.stringify({
      status: "running",
      children: { c1: { status: "running", usage: { input: 3, output: 4 } } },
    }));
    const bumped = new Date(now + 60_000);
    utimesSync(statusPath, bumped, bumped);
    clock.mockReturnValue(now + 999);
    expect(listRunSummaries(CWD, opts)[0]?.tokens).toBe(7);
    expect(snapshotReads).toBe(2);
    expect(ownerProbes).toBe(1);

    clock.mockReturnValue(now + 1_000);
    expect(listRunSummaries(CWD, opts)[0]?.status).toBe("running");
    expect(snapshotReads).toBe(2);
    expect(ownerProbes).toBe(2);
  } finally {
    clock.mockRestore();
  }
});

test("a resume rewrite invalidates a terminal projection and reclassifies it as live", () => {
  const runId = "workflow-resume-cache";
  const root = makeRoot([{
    runId,
    runJson: {
      runId,
      kind: "workflow",
      createdAt: "2026-07-11T10:00:00.000Z",
      children: [{ id: "c1", spec: { prompt: "again" } }],
    },
    statusJson: { status: "completed", children: { c1: { status: "completed" } } },
    events: [JSON.stringify({ timestamp: "2026-07-11T10:00:05.000Z", type: "workflow_completed" })],
  }]);
  const runDir = join(root, encodeCwd(CWD), runId);
  let snapshotReads = 0;
  const opts = {
    root,
    readSnapshot(path: string) {
      snapshotReads += 1;
      return readRunSnapshot(path);
    },
    ownerIsLive: () => true,
  };

  expect(listRunSummaries(CWD, opts)[0]?.status).toBe("completed");
  expect(snapshotReads).toBe(1);

  writeFileSync(join(runDir, "generation.pending"), JSON.stringify({ v: 1 }));
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ status: "running", children: { c1: { status: "running" } } }));
  const eventsPath = join(runDir, "events.jsonl");
  writeFileSync(eventsPath, [
    JSON.stringify({ timestamp: "2026-07-11T10:00:05.000Z", type: "workflow_completed" }),
    JSON.stringify({ timestamp: "2026-07-11T11:00:00.000Z", type: "resumed" }),
    JSON.stringify({ timestamp: "2026-07-11T11:00:01.000Z", type: "workflow_started" }),
  ].join("\n"));
  unlinkSync(join(runDir, "generation.pending"));
  const bumped = new Date(Date.now() + 60_000);
  utimesSync(join(runDir, "status.json"), bumped, bumped);
  utimesSync(eventsPath, bumped, bumped);

  expect(listRunSummaries(CWD, opts)[0]?.status).toBe("running");
  expect(snapshotReads).toBe(2);
  expect(listRunSummaries(CWD, opts)[0]?.status).toBe("running");
  expect(snapshotReads).toBe(2);
});

test("terminal details reuse projections unless explicitly bypassed by NavigatorModel", () => {
  const runId = "terminal-detail-cache";
  const root = makeRoot([{
    runId,
    runJson: {
      runId,
      kind: "subagent",
      createdAt: "2026-07-11T10:00:00.000Z",
      children: [{ id: "c1", spec: { prompt: "done" } }],
    },
    statusJson: { status: "completed", children: { c1: { status: "completed" } } },
    events: [],
  }]);
  const runDir = join(root, encodeCwd(CWD), runId);
  let snapshotReads = 0;
  const opts = {
    root,
    readSnapshot(path: string) {
      snapshotReads += 1;
      return readRunSnapshot(path);
    },
  };

  const first = readRunDetail(runDir, runId, opts);
  first.status = "failed";
  first.children[0]!.status = "failed";
  const cached = readRunDetail(runDir, runId, opts);
  expect(cached).not.toBe(first);
  expect(cached.status).toBe("completed");
  expect(cached.children[0]?.status).toBe("completed");
  cached.status = "failed";
  cached.children.length = 0;
  const cachedAgain = readRunDetail(runDir, runId, opts);
  expect(cachedAgain).not.toBe(cached);
  expect(cachedAgain.status).toBe("completed");
  expect(cachedAgain.children).toHaveLength(1);
  expect(snapshotReads).toBe(1);

  const model = new NavigatorModel(CWD, opts);
  expect(model.detail(runId).status).toBe("completed");
  writeFileSync(join(runDir, "status.json"), JSON.stringify({
    status: "failed",
    children: { c1: { status: "failed" } },
  }));
  const refreshed = model.detail(runId);
  expect(refreshed.status).toBe("failed");
  expect(refreshed.children[0]?.status).toBe("failed");
  expect(snapshotReads).toBe(3);
});

test("generation.pending quarantines an otherwise-completed run with a recovery label", () => {
  const runId = "workflow-quarantined";
  const root = makeRoot([{
    runId,
    runJson: {
      runId,
      kind: "workflow",
      createdAt: "2026-07-11T10:00:00.000Z",
      children: [{ id: "c1", spec: { prompt: "done" } }],
    },
    statusJson: { status: "completed", children: { c1: { status: "completed", usage: { input: 1, output: 1 } } } },
    script: "return 'complete';",
    generationPending: true,
  }]);
  const runDir = join(root, encodeCwd(CWD), runId);

  expect(listRunSummaries(CWD, { root })).toContainEqual(expect.objectContaining({
    runId,
    label: "quarantined - crashed mid-resume",
    status: "failed",
    corrupt: true,
  }));
  expect(readRunDetail(runDir, runId, { root })).toMatchObject({
    runId,
    label: "quarantined - crashed mid-resume",
    status: "failed",
    children: [],
    hasScript: false,
    corrupt: true,
  });
});

test("follow-up runs and children carry a continuation label", () => {
  const runId = "run-follow-up";
  const followUpOf = { runId: "run-source", childId: "source-child" };
  const root = makeRoot([{
    runId,
    runJson: {
      runId,
      kind: "subagent",
      createdAt: "2026-07-11T10:00:00.000Z",
      children: [{ id: "continued", spec: { prompt: "continue", label: "source" }, followUpOf }],
    },
    statusJson: { status: "completed", children: { continued: { status: "completed", usage: { input: 1, output: 1 } } } },
  }]);
  const runDir = join(root, encodeCwd(CWD), runId);

  expect(listRunSummaries(CWD, { root })[0]?.label).toBe("source (follow-up)");
  expect(readRunDetail(runDir, runId, { root }).children[0]).toMatchObject({
    label: "source (follow-up)",
    followUpOf,
  });
});

test("readRunDetail recovers per-child timing/activity and narrator lines from events", () => {
  const root = makeRoot([
    {
      runId: "workflow-1",
      runJson: { runId: "workflow-1", kind: "workflow", createdAt: "2026-07-11T10:00:00.000Z", phases: [{ title: "plan" }, { title: "build" }], children: [{ id: "c1", spec: { prompt: "plan it" }, phase: "plan", resolved: { modelId: "openai-codex/gpt-5.6-sol" }, sessionFile: "/s/c1.jsonl" }] },
      statusJson: { status: "running", children: { c1: { status: "running", usage: { input: 200, output: 100 } } } },
      events: [
        JSON.stringify({ timestamp: "2026-07-11T10:00:04.000Z", type: "phase", title: "plan" }),
        JSON.stringify({ timestamp: "2026-07-11T10:00:02.000Z", type: "status", id: "c1", status: "running" }),
        JSON.stringify({ timestamp: "2026-07-11T10:00:01.000Z", type: "log", message: "planning underway" }),
        JSON.stringify({ timestamp: "2026-07-11T10:00:01.000Z", type: "phase", title: "build" }),
        JSON.stringify({ timestamp: "2026-07-11T10:00:04.000Z", type: "activity", id: "c1", description: "bash ls" }),
      ],
    },
  ]);

  const detail = readRunDetail(join(root, encodeCwd(CWD), "workflow-1"), "workflow-1", { root });
  expect(detail.corrupt).toBe(false);
  expect(detail.phases.map((p) => p.title)).toEqual(["plan", "build"]);
  expect(detail.children).toHaveLength(1);
  const child = detail.children[0]!;
  expect(child.model).toBe("gpt-5.6-sol");
  expect(child.tokens).toBe(300);
  expect(child.activity).toBe("bash ls");
  expect(child.startedAt).toBeGreaterThan(0);
  expect(child.sessionFile).toBe("/s/c1.jsonl");
  expect(detail.narrator.map((n) => `${n.kind}:${n.text}`)).toEqual(["phase:plan", "log:planning underway", "phase:build"]);
});

test("a reconciled terminal status event freezes the child duration", () => {
  const root = makeRoot([{
    runId: "workflow-reconciled-duration",
    runJson: {
      runId: "workflow-reconciled-duration",
      kind: "workflow",
      createdAt: "2026-07-11T10:00:00.000Z",
      children: [{ id: "old-child", spec: { prompt: "old work" } }],
    },
    statusJson: {
      status: "completed",
      children: { "old-child": { status: "aborted", usage: { input: 1, output: 1 } } },
    },
    events: [
      JSON.stringify({ timestamp: "2026-07-11T10:00:01.000Z", type: "status", id: "old-child", status: "running" }),
      JSON.stringify({ timestamp: "2026-07-11T10:00:06.000Z", type: "status", id: "old-child", status: "aborted", reason: "superseded by workflow resume" }),
      JSON.stringify({ timestamp: "2026-07-11T10:00:06.000Z", type: "workflow_started" }),
      JSON.stringify({ timestamp: "2026-07-11T10:00:07.000Z", type: "workflow_completed" }),
    ],
  }]);

  const detail = readRunDetail(
    join(root, encodeCwd(CWD), "workflow-reconciled-duration"),
    "workflow-reconciled-duration",
    { root },
  );
  expect(detail.children[0]).toMatchObject({
    status: "aborted",
    startedAt: Date.parse("2026-07-11T10:00:01.000Z"),
    endedAt: Date.parse("2026-07-11T10:00:06.000Z"),
  });
});

test("repeated workflow resumes render narration from only the latest execution generation", () => {
  const events = [
    { timestamp: "2026-07-11T10:00:00.000Z", type: "created" },
    { timestamp: "2026-07-11T10:00:00.500Z", type: "workflow_started" },
    { timestamp: "2026-07-11T10:00:01.000Z", type: "phase", title: "plan" },
    { timestamp: "2026-07-11T10:00:02.000Z", type: "log", message: "planning underway" },
    { timestamp: "2026-07-11T10:00:03.000Z", type: "workflow_completed" },
    { timestamp: "2026-07-11T10:01:00.000Z", type: "resumed" },
    { timestamp: "2026-07-11T10:01:00.500Z", type: "workflow_started" },
    { timestamp: "2026-07-11T10:01:01.000Z", type: "phase", title: "plan" },
    { timestamp: "2026-07-11T10:01:02.000Z", type: "log", message: "planning underway" },
    { timestamp: "2026-07-11T10:01:03.000Z", type: "workflow_completed" },
    // This resume attempt fails during setup and must not clear narration.
    { timestamp: "2026-07-11T10:01:30.000Z", type: "resumed" },
    { timestamp: "2026-07-11T10:02:00.000Z", type: "resumed" },
    { timestamp: "2026-07-11T10:02:00.500Z", type: "workflow_started" },
    { timestamp: "2026-07-11T10:02:01.000Z", type: "phase", title: "plan" },
    { timestamp: "2026-07-11T10:02:02.000Z", type: "log", message: "planning underway" },
    { timestamp: "2026-07-11T10:02:03.000Z", type: "workflow_completed" },
  ];
  const root = makeRoot([{
    runId: "workflow-resumed",
    runJson: { runId: "workflow-resumed", kind: "workflow", createdAt: "2026-07-11T10:00:00.000Z", phases: [{ title: "plan" }], children: [] },
    statusJson: { status: "completed", children: {} },
    events: events.map((event) => JSON.stringify(event)),
  }]);
  const runDir = join(root, encodeCwd(CWD), "workflow-resumed");

  const detail = readRunDetail(runDir, "workflow-resumed", { root });

  expect(detail.narrator.map((line) => `${line.kind}:${line.text}`)).toEqual([
    "phase:plan",
    "log:planning underway",
  ]);
  // Reading is projection-only: all lifecycle generations remain append-only.
  expect(readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(events.length);
});

test("a refused resume restores the prior generation's narration and narrates the refusal", () => {
  const events = [
    { timestamp: "2026-07-11T10:00:00.000Z", type: "created" },
    { timestamp: "2026-07-11T10:00:00.500Z", type: "workflow_started" },
    { timestamp: "2026-07-11T10:00:01.000Z", type: "phase", title: "plan" },
    { timestamp: "2026-07-11T10:00:02.000Z", type: "log", message: "planning underway" },
    { timestamp: "2026-07-11T10:00:03.000Z", type: "workflow_completed" },
    // A refused drift resume: the generation started (clearing narration) and
    // even reached a phase before the replay decision refused it.
    { timestamp: "2026-07-11T10:01:00.000Z", type: "resumed" },
    { timestamp: "2026-07-11T10:01:00.500Z", type: "workflow_started" },
    { timestamp: "2026-07-11T10:01:01.000Z", type: "phase", title: "plan" },
    { timestamp: "2026-07-11T10:01:02.000Z", type: "workflow_resume_refused", error: "Cannot replay workflow call child-1 (aud\u001b[31mit): its execution environment changed\nsecond line" },
  ];
  const root = makeRoot([{
    runId: "workflow-refused",
    runJson: { runId: "workflow-refused", kind: "workflow", createdAt: "2026-07-11T10:00:00.000Z", phases: [{ title: "plan" }], children: [] },
    statusJson: { status: "completed", children: {} },
    events: events.map((event) => JSON.stringify(event)),
  }]);
  const runDir = join(root, encodeCwd(CWD), "workflow-refused");

  const detail = readRunDetail(runDir, "workflow-refused", { root });

  // The completed generation's narration is back, the refused attempt's
  // partial lines are not, and the refusal is narrated: first line only,
  // terminal-sanitized (the reason can embed an authored call label).
  expect(detail.narrator.map((line) => `${line.kind}:${line.text}`)).toEqual([
    "phase:plan",
    "log:planning underway",
    "log:resume refused: Cannot replay workflow call child-1 (audit): its execution environment changed",
  ]);
});

test("structurally malformed run.json (valid JSON, wrong shape) renders as corrupt, not a crash", () => {
  const root = mkdtempSync(join(tmpdir(), "store-read-shape-"));
  const runDir = join(root, encodeCwd(CWD), "run-bad");
  mkdirSync(runDir, { recursive: true });
  // Parses fine, but children holds a null and a non-string prompt - the paths
  // that previously threw inside label derivation.
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ kind: "subagent", createdAt: "x", children: [null, { spec: { prompt: 42 } }] }));

  const summaries = listRunSummaries(CWD, { root });
  const bad = summaries.find((s) => s.runId === "run-bad")!;
  expect(bad.corrupt).toBe(true);
  expect(() => readRunDetail(runDir, "run-bad", { root })).not.toThrow();
  expect(readRunDetail(runDir, "run-bad", { root }).corrupt).toBe(true);
});

test("summary and detail both tolerate wrong-typed detail fields per field", () => {
  const runId = "workflow-detail-tolerance";
  const root = makeRoot([{
    runId,
    runJson: {
      runId,
      kind: "workflow",
      createdAt: "2026-07-11T10:00:00.000Z",
      phases: [null, { title: 7 }, { title: "Build" }],
      children: [{
        id: "c1",
        spec: { prompt: 42, label: 7, phase: 9 },
        phase: 8,
        resolved: { modelId: 7 },
        sessionFile: 9,
      }],
    },
    statusJson: {
      status: "completed",
      children: { c1: { status: "completed", usage: { input: 2, output: 3 } } },
    },
    events: [JSON.stringify({
      timestamp: "2026-07-11T10:00:05.000Z",
      type: "result",
      id: "c1",
      result: { status: "completed", text: 17, error: 23, usage: { input: 2, output: 3 } },
    })],
  }]);
  const runDir = join(root, encodeCwd(CWD), runId);

  expect(readRunSummary(runDir, runId, { root })).toMatchObject({ corrupt: false, status: "completed" });
  expect(readRunDetail(runDir, runId, { root })).toMatchObject({
    corrupt: false,
    status: "completed",
    phases: [{ title: "Build" }],
    children: [{
      id: "c1",
      label: "c1",
      model: "",
      phase: undefined,
      resultLine: undefined,
      error: undefined,
      sessionFile: undefined,
    }],
  });
});

test("dead-parent runs reconcile: event terminals fold in, survivors read aborted, owned runs stay live", () => {
  const root = makeRoot([
    {
      // Owner died mid-run: c1's result event beat the status.json write
      // (crash window), c2 was still running. Only stale owner metadata remains.
      runId: "run-dead",
      runJson: { runId: "run-dead", kind: "subagent", createdAt: "2026-07-11T09:00:00.000Z", children: [{ id: "c1", spec: { prompt: "a" } }, { id: "c2", spec: { prompt: "b" } }] },
      statusJson: { status: "running", children: { c1: { status: "running", usage: { input: 1, output: 1 } }, c2: { status: "running", usage: { input: 1, output: 1 } } } },
      events: [
        JSON.stringify({ timestamp: "2026-07-11T09:00:05.000Z", type: "result", id: "c1", result: { status: "completed", text: "done first", usage: { input: 2, output: 2 } } }),
      ],
      deadOwner: true,
    },
    {
      // A dead workflow is aborted even if every child completed: the loop died.
      runId: "workflow-dead",
      runJson: { runId: "workflow-dead", kind: "workflow", createdAt: "2026-07-11T09:30:00.000Z", children: [{ id: "w1", spec: { prompt: "x" } }] },
      statusJson: { status: "running", children: { w1: { status: "completed", usage: { input: 1, output: 1 } } } },
      deadOwner: true,
    },
    {
      // Same shape as run-dead but a held SQLite owner: stays running untouched.
      runId: "run-owned",
      runJson: { runId: "run-owned", kind: "subagent", createdAt: "2026-07-11T09:45:00.000Z", children: [{ id: "o1", spec: { prompt: "a" } }] },
      statusJson: { status: "running", children: { o1: { status: "running", usage: { input: 1, output: 1 } } } },
      liveOwner: true,
    },
  ]);

  const rows = listRunSummaries(CWD, { root });
  const dead = rows.find((row) => row.runId === "run-dead")!;
  expect(dead.reconciled).toBe(true);
  expect(dead.status).toBe("aborted");
  expect(dead.done).toBe(2);
  expect(dead.tokens).toBe(6);
  const deadWorkflow = rows.find((row) => row.runId === "workflow-dead")!;
  expect(deadWorkflow.status).toBe("aborted");
  const owned = rows.find((row) => row.runId === "run-owned")!;
  expect(owned.reconciled).toBe(false);
  expect(owned.status).toBe("running");

  const detail = readRunDetail(join(root, encodeCwd(CWD), "run-dead"), "run-dead", { root });
  const byId = new Map(detail.children.map((child) => [child.id, child]));
  expect(byId.get("c1")).toMatchObject({ status: "completed", tokens: 4 }); // terminal result event survives the crash window
  expect(byId.get("c2")).toMatchObject({ status: "aborted", tokens: 2 }); // died with its owner
  expect(detail.status).toBe("aborted");
});

test("an unchanged dead-owner terminal projection skips further snapshot reads and owner probes", () => {
  const runId = "run-dead-cache";
  const root = makeRoot([{
    runId,
    runJson: {
      runId,
      kind: "subagent",
      createdAt: "2026-07-11T10:00:00.000Z",
      children: [{ id: "c1", spec: { prompt: "orphaned" } }],
    },
    statusJson: { status: "running", children: { c1: { status: "running" } } },
    events: [],
    deadOwner: true,
  }]);
  let snapshotReads = 0;
  let ownerProbes = 0;
  const opts = {
    root,
    readSnapshot(runDir: string) {
      snapshotReads += 1;
      return readRunSnapshot(runDir);
    },
    ownerIsLive() {
      ownerProbes += 1;
      return false;
    },
  };

  expect(listRunSummaries(CWD, opts)[0]).toMatchObject({
    status: "aborted",
    reconciled: true,
  });
  expect(snapshotReads).toBe(1);
  expect(ownerProbes).toBe(1);

  expect(listRunSummaries(CWD, opts)[0]).toMatchObject({
    status: "aborted",
    reconciled: true,
  });
  expect(snapshotReads).toBe(1);
  expect(ownerProbes).toBe(1);
});

test("a dead-owner race self-corrects after completion rewrites status", () => {
  const runId = "run-completed-during-probe";
  const root = makeRoot([{
    runId,
    runJson: {
      runId,
      kind: "subagent",
      createdAt: "2026-07-11T10:00:00.000Z",
      children: [{ id: "c1", spec: { prompt: "finish now" } }],
    },
    statusJson: {
      status: "running",
      children: { c1: { status: "running", usage: { input: 1, output: 1 } } },
    },
    events: [],
  }]);
  const runDir = join(root, encodeCwd(CWD), runId);
  let snapshotReads = 0;
  let ownerProbes = 0;

  const summary = readRunSummary(runDir, runId, {
    readSnapshot(path) {
      snapshotReads += 1;
      return readRunSnapshot(path);
    },
    ownerIsLive(path) {
      ownerProbes += 1;
      writeFileSync(join(path, "status.json"), JSON.stringify({
        status: "completed",
        children: { c1: { status: "completed", usage: { input: 2, output: 3 } } },
      }));
      const bumped = new Date(Date.now() + 60_000);
      utimesSync(join(path, "status.json"), bumped, bumped);
      return false;
    },
  });

  expect(snapshotReads).toBe(1);
  expect(ownerProbes).toBe(1);
  expect(summary).toMatchObject({
    status: "aborted",
    done: 1,
    tokens: 2,
    corrupt: false,
    reconciled: true,
  });

  const corrected = readRunSummary(runDir, runId, {
    readSnapshot(path) {
      snapshotReads += 1;
      return readRunSnapshot(path);
    },
    ownerIsLive() {
      ownerProbes += 1;
      return false;
    },
  });
  expect(corrected).toMatchObject({
    status: "completed",
    done: 1,
    tokens: 5,
    reconciled: false,
  });
  expect(snapshotReads).toBe(2);
  expect(ownerProbes).toBe(1);
});

test("terminal snapshot skips the owner probe and refresh", () => {
  const runId = "run-already-completed";
  const root = makeRoot([{
    runId,
    runJson: {
      runId,
      kind: "subagent",
      createdAt: "2026-07-11T10:00:00.000Z",
      children: [{ id: "c1", spec: { prompt: "already done" } }],
    },
    statusJson: {
      status: "completed",
      children: { c1: { status: "completed", usage: { input: 2, output: 3 } } },
    },
    events: [],
  }]);
  const runDir = join(root, encodeCwd(CWD), runId);
  let snapshotReads = 0;
  let ownerProbes = 0;

  const summary = readRunSummary(runDir, runId, {
    readSnapshot(path) {
      snapshotReads += 1;
      return readRunSnapshot(path);
    },
    ownerIsLive() {
      ownerProbes += 1;
      return false;
    },
  });

  expect(snapshotReads).toBe(1);
  expect(ownerProbes).toBe(0);
  expect(summary.status).toBe("completed");
  expect(summary.reconciled).toBe(false);
});

test("a negative owner-probe race self-corrects after resume rewrites status", () => {
  const runId = "run-resumed-during-refresh";
  const root = makeRoot([{
    runId,
    runJson: {
      runId,
      kind: "subagent",
      createdAt: "2026-07-11T10:00:00.000Z",
      children: [{ id: "c1", spec: { prompt: "resume now" } }],
    },
    statusJson: {
      status: "running",
      children: { c1: { status: "running", usage: { input: 2, output: 3 } } },
    },
    events: [],
  }]);
  const runDir = join(root, encodeCwd(CWD), runId);
  let snapshotReads = 0;
  let ownerProbes = 0;
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);

  const summary = readRunSummary(runDir, runId, {
    readSnapshot(path) {
      snapshotReads += 1;
      return readRunSnapshot(path);
    },
    ownerIsLive() {
      ownerProbes += 1;
      if (ownerProbes === 1) {
        writeFileSync(join(runDir, "status.json"), JSON.stringify({
          status: "running",
          children: { c1: { status: "running", usage: { input: 3, output: 4 } } },
        }));
        const bumped = new Date(Date.now() + 60_000);
        utimesSync(join(runDir, "status.json"), bumped, bumped);
        return false;
      }
      return true;
    },
  });

  expect(snapshotReads).toBe(1);
  expect(ownerProbes).toBe(1);
  expect(summary.status).toBe("aborted");
  expect(summary.reconciled).toBe(true);

  clock.mockReturnValue(now + 1_000);
  const corrected = readRunSummary(runDir, runId, {
    readSnapshot(path) {
      snapshotReads += 1;
      return readRunSnapshot(path);
    },
    ownerIsLive() {
      ownerProbes += 1;
      return true;
    },
  });
  expect(snapshotReads).toBe(2);
  expect(ownerProbes).toBe(2);
  expect(corrected.status).toBe("running");
  expect(corrected.tokens).toBe(7);
  expect(corrected.reconciled).toBe(false);
  clock.mockRestore();
});

test("a reconciled dead-owner projection expires and re-probes after the TTL", () => {
  const runId = "run-reconciled-ttl";
  const root = makeRoot([{
    runId,
    runJson: {
      runId,
      kind: "subagent",
      createdAt: "2026-07-11T10:00:00.000Z",
      children: [{ id: "c1", spec: { prompt: "acquired later" } }],
    },
    statusJson: { status: "running", children: { c1: { status: "running" } } },
    events: [],
    deadOwner: true,
  }]);
  let ownerProbes = 0;
  let ownerLive = false;
  const opts = {
    root,
    ownerIsLive() {
      ownerProbes += 1;
      return ownerLive;
    },
  };

  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    // Dead owner: reconciled to aborted and cached.
    expect(listRunSummaries(CWD, opts)[0]).toMatchObject({ status: "aborted", reconciled: true });
    expect(ownerProbes).toBe(1);

    // A resume acquires the lock without changing any relevant file mtime yet.
    // Within the TTL the stale reconciled row is permissible...
    ownerLive = true;
    expect(listRunSummaries(CWD, opts)[0]?.status).toBe("aborted");
    expect(ownerProbes).toBe(1);

    // ...but a reconciled classification depends on lock state, so it must
    // expire like a live one and re-probe, correcting without any file write.
    clock.mockReturnValue(now + 1_001);
    expect(listRunSummaries(CWD, opts)[0]).toMatchObject({ status: "running", reconciled: false });
    expect(ownerProbes).toBe(2);
  } finally {
    clock.mockRestore();
  }
});
