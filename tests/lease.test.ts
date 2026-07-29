import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRunOwnership,
  OWNER_FILE,
  runOwnerIsLive,
  RunOwnershipConflictError,
} from "../src/store/lease.js";

function runDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("run ownership is exclusive between connections in the same process", () => {
  const dir = runDirectory("ownership-exclusive-");
  const first = acquireRunOwnership(dir);
  try {
    expect(() => acquireRunOwnership(dir)).toThrow(RunOwnershipConflictError);
    expect(runOwnerIsLive(dir)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, OWNER_FILE), "utf8"))).toEqual(first.owner);
  } finally {
    first.release();
  }
});

test("released ownership can be reacquired", () => {
  const dir = runDirectory("ownership-reacquire-");
  const first = acquireRunOwnership(dir);
  first.release();
  expect(existsSync(join(dir, OWNER_FILE))).toBe(false);

  const second = acquireRunOwnership(dir);
  expect(second.owner).toMatchObject({ v: 1, pid: process.pid, host: hostname() });
  second.release();
});

test("liveness probes the held SQLite transaction, not owner metadata", () => {
  const dir = runDirectory("ownership-probe-");
  expect(runOwnerIsLive(dir)).toBe(false);
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify({
    v: 1,
    pid: 4242,
    host: hostname(),
    startedAt: "2026-07-12T10:00:00.000Z",
  }));
  expect(runOwnerIsLive(dir)).toBe(false);

  const ownership = acquireRunOwnership(dir);
  expect(runOwnerIsLive(dir)).toBe(true);
  ownership.release();
  expect(runOwnerIsLive(dir)).toBe(false);
});

test("owner metadata from another host requires an explicit manual override", () => {
  const dir = runDirectory("ownership-cross-host-");
  const ownerPath = join(dir, OWNER_FILE);
  writeFileSync(ownerPath, JSON.stringify({
    v: 1,
    pid: 4242,
    host: "shared-filesystem-host",
    startedAt: "2026-07-12T10:00:00.000Z",
  }));

  expect(() => acquireRunOwnership(dir)).toThrow(
    `Run was owned on another host (shared-filesystem-host); cross-host sharing is unsupported. After confirming no pi process on shared-filesystem-host still owns it, delete ${ownerPath} to override manually`,
  );
  expect(runOwnerIsLive(dir)).toBe(false);

  rmSync(ownerPath);
  const ownership = acquireRunOwnership(dir);
  ownership.release();
});

test("the cross-host guard does not depend on complete diagnostic metadata", () => {
  const dir = runDirectory("ownership-cross-host-incomplete-");
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ host: "shared-filesystem-host" }));

  expect(() => acquireRunOwnership(dir)).toThrow(
    "Run was owned on another host (shared-filesystem-host); cross-host sharing is unsupported",
  );
  expect(runOwnerIsLive(dir)).toBe(false);
});

test("a conflict reports the pid, host, and start time from owner metadata", () => {
  const dir = runDirectory("ownership-conflict-details-");
  const ownership = acquireRunOwnership(dir);
  const owner = {
    v: 1,
    pid: 4242,
    host: hostname(),
    startedAt: "2026-07-12T10:00:00.000Z",
  } as const;
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify(owner));

  let conflict: unknown;
  try {
    acquireRunOwnership(dir);
  } catch (error) {
    conflict = error;
  } finally {
    ownership.release();
  }

  expect(conflict).toBeInstanceOf(RunOwnershipConflictError);
  expect((conflict as RunOwnershipConflictError).owner).toEqual(owner);
  expect((conflict as Error).message).toBe(
    "Run is active in another owner (pid 4242 on " + hostname() + ", started at 2026-07-12T10:00:00.000Z)",
  );
});

test("liveness reports not-live when the owner database cannot be opened", () => {
  // The probe races anything that deletes a run directory, and existsSync cannot
  // close that window: the file can vanish between the check and the open, which
  // surfaces as SQLITE_CANTOPEN. Readers include the /agents disk projection, so a
  // throw would reach a render path - and it made the suite flaky, because tests
  // remove their temp roots while async work is still probing. An unopenable
  // owner database is stood in for here by a directory of the same name.
  const runDir = runDirectory("lease-unopenable-");
  try {
    mkdirSync(join(runDir, "owner.sqlite"));
    expect(runOwnerIsLive(runDir)).toBe(false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("liveness reports not-live for a run directory that no longer exists", () => {
  const runDir = runDirectory("lease-vanished-");
  rmSync(runDir, { recursive: true, force: true });
  expect(runOwnerIsLive(runDir)).toBe(false);
});
