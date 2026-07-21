import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSqliteLock,
  isSqliteBusyError,
  MAX_SQLITE_BUSY_WAIT_MS,
  probeSqliteLock,
  SqliteLockBusyError,
  withSqliteMutex,
} from "../src/store/sqlite-lock.js";

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "sqlite-lock-")), "lock.sqlite");
}

test("separate connections in one process exclude each other and release cleanly", () => {
  const path = lockPath();
  const first = acquireSqliteLock(path);
  expect(() => acquireSqliteLock(path)).toThrow(SqliteLockBusyError);
  expect(statSync(path).mode & 0o777).toBe(0o600);

  first.release();
  const second = acquireSqliteLock(path);
  second.release();
});

test("busy classification covers Bun and node:sqlite error shapes", () => {
  expect(isSqliteBusyError({ code: "SQLITE_BUSY" })).toBe(true);
  expect(isSqliteBusyError({ code: "SQLITE_BUSY", errno: 5 })).toBe(true);
  expect(isSqliteBusyError({ code: "SQLITE_BUSY_SNAPSHOT", errno: 517 })).toBe(true);
  expect(isSqliteBusyError({ code: "ERR_SQLITE_ERROR", errcode: 5 })).toBe(true);
  expect(isSqliteBusyError({ code: "ERR_SQLITE_ERROR", errcode: 517 })).toBe(true);
  expect(isSqliteBusyError({ code: "SQLITE_ERROR", errno: 6 })).toBe(false);
  expect(isSqliteBusyError({ code: "SQLITE_ERROR", errno: 518 })).toBe(false);
  expect(isSqliteBusyError({ code: "ERR_SQLITE_ERROR", errcode: 6 })).toBe(false);
  expect(isSqliteBusyError({ code: "ERR_SQLITE_ERROR", errcode: 518 })).toBe(false);
  expect(isSqliteBusyError({ code: "SQLITE_ERROR" })).toBe(false);
  expect(isSqliteBusyError(undefined)).toBe(false);
});

test("busy wait is normalized before the database is opened", () => {
  const path = lockPath();
  const primary = new Error("broken busy wait");
  const waitForBusyMs = {
    valueOf(): number {
      throw primary;
    },
  } as unknown as number;

  expect(() => acquireSqliteLock(path, waitForBusyMs)).toThrow(primary);
  expect(existsSync(path)).toBe(false);
});

test("all requested busy waits are capped at 250ms", () => {
  expect(MAX_SQLITE_BUSY_WAIT_MS).toBe(250);
  const path = lockPath();
  const held = acquireSqliteLock(path);
  const startedAt = Date.now();
  try {
    expect(() => acquireSqliteLock(path, 2_000)).toThrow(SqliteLockBusyError);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  } finally {
    held.release();
  }
});

test("warning filter passes through unrelated SQLite experimental warnings", async () => {
  const moduleUrl = new URL("../src/store/sqlite-lock.ts", import.meta.url).href;
  const path = lockPath();
  const script = `
    const forwarded = [];
    process.emitWarning = (warning, ...args) => {
      forwarded.push({
        message: warning instanceof Error ? warning.message : String(warning),
        type: args[0],
      });
    };
    const { acquireSqliteLock } = await import(${JSON.stringify(moduleUrl)});
    acquireSqliteLock(${JSON.stringify(path)}).release();
    process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
    process.emitWarning("SQLite is an experimental feature and might change at any time: cache policy changed", "ExperimentalWarning");
    process.emitWarning("SQLite cache policy changed", "ExperimentalWarning");
    const forwardedSqliteWarnings = forwarded.filter(({ message }) => message.includes("SQLite"));
    const expected = [
      { message: "SQLite is an experimental feature and might change at any time: cache policy changed", type: "ExperimentalWarning" },
      { message: "SQLite cache policy changed", type: "ExperimentalWarning" },
    ];
    if (JSON.stringify(forwardedSqliteWarnings) !== JSON.stringify(expected)) {
      throw new Error("unexpected forwarded SQLite warnings: " + JSON.stringify(forwarded));
    }
  `;
  const proc = Bun.spawn([
    "node",
    "--no-warnings",
    "--experimental-transform-types",
    "--input-type=module",
    "--eval",
    script,
  ], { stdout: "ignore", stderr: "pipe" });
  try {
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`node run failed (code ${exitCode}):\n${stderr}`);
  } finally {
    proc.kill();
    await proc.exited;
  }
});

test("probe reports a held writer and then a free database", () => {
  const path = lockPath();
  expect(probeSqliteLock(path)).toBe("free");
  const lock = acquireSqliteLock(path);
  expect(probeSqliteLock(path)).toBe("held");
  lock.release();
  expect(probeSqliteLock(path)).toBe("free");
});

test("mutex excludes nested actions and always releases after an exception", () => {
  const path = lockPath();
  withSqliteMutex(path, () => {
    expect(() => withSqliteMutex(path, () => {})).toThrow(SqliteLockBusyError);
  });

  expect(() => withSqliteMutex(path, () => { throw new Error("action failed"); })).toThrow("action failed");
  expect(withSqliteMutex(path, () => "reacquired")).toBe("reacquired");
});
