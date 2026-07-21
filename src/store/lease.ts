/** OS-backed run ownership with reader-facing metadata. */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { isRecord } from "../util.js";
import { replaceAtomicFile } from "./atomic-file.js";
import {
  acquireSqliteLock,
  probeSqliteLock,
  SqliteLockBusyError,
  type SqliteLockHandle,
} from "./sqlite-lock.js";

interface RunOwnerRecord {
  v: 1;
  pid: number;
  host: string;
  startedAt: string;
}

export interface RunOwnership {
  readonly owner: RunOwnerRecord;
  release(): void;
}

export const OWNER_FILE = "owner.json";
const OWNER_DATABASE_FILE = "owner.sqlite";

export class RunOwnershipConflictError extends Error {
  constructor(readonly owner?: RunOwnerRecord) {
    super(owner
      ? `Run is active in another owner (pid ${owner.pid} on ${owner.host}, started at ${owner.startedAt})`
      : "Run is active in another owner");
    this.name = "RunOwnershipConflictError";
  }
}

/** Acquire the run for this process and publish descriptive owner metadata. */
export function acquireRunOwnership(runDir: string): RunOwnership {
  const databasePath = join(runDir, OWNER_DATABASE_FILE);
  let lock: SqliteLockHandle;
  try {
    // Readers probe liveness by transiently taking this lock, so a fail-fast
    // acquire could refuse a legitimate resume that races a navigator tick.
    lock = acquireSqliteLock(databasePath, 250);
  } catch (error) {
    if (error instanceof SqliteLockBusyError) throw new RunOwnershipConflictError(readOwner(runDir));
    throw error;
  }

  const ownerPath = join(runDir, OWNER_FILE);
  try {
    const host = hostname();
    const existingHost = readOwnerMetadata(runDir)?.host;
    if (typeof existingHost === "string" && existingHost.length > 0 && existingHost !== host) {
      throw new Error(
        `Run was owned on another host (${existingHost}); cross-host sharing is unsupported. After confirming no pi process on ${existingHost} still owns it, delete ${ownerPath} to override manually`,
      );
    }
    const owner: RunOwnerRecord = {
      v: 1,
      pid: process.pid,
      host,
      startedAt: new Date().toISOString(),
    };
    replaceAtomicFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });

    let released = false;
    return {
      owner,
      release: () => {
        if (released) return;
        released = true;
        try {
          rmSync(ownerPath, { force: true });
        } catch {
          // Metadata is advisory. The SQLite transaction is the ownership.
        } finally {
          lock.release();
        }
      },
    };
  } catch (error) {
    lock.release();
    throw error;
  }
}

/** Whether a process currently holds this run's SQLite ownership transaction. */
export function runOwnerIsLive(runDir: string): boolean {
  const databasePath = join(runDir, OWNER_DATABASE_FILE);
  return existsSync(databasePath) && probeSqliteLock(databasePath) === "held";
}

function readOwner(runDir: string): RunOwnerRecord | undefined {
  const value = readOwnerMetadata(runDir) as Partial<RunOwnerRecord> | undefined;
  return value?.v === 1
    && Number.isSafeInteger(value.pid)
    && (value.pid as number) > 0
    && typeof value.host === "string"
    && typeof value.startedAt === "string"
    ? value as RunOwnerRecord
    : undefined;
}

function readOwnerMetadata(runDir: string): Record<string, unknown> | undefined {
  try {
    const owner: unknown = JSON.parse(readFileSync(join(runDir, OWNER_FILE), "utf8"));
    return isRecord(owner) ? owner : undefined;
  } catch {
    return undefined;
  }
}
