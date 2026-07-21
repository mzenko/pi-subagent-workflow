import { expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  commitAtomicFile,
  replaceAtomicFile,
  stageAtomicFile,
  syncDirectoryDurably,
} from "../src/store/atomic-file.js";

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "atomic-file-"));
}

test("staging uses same-directory O_EXCL files and completes partial UTF-8 byte writes", () => {
  const directory = temporaryRoot();
  const path = join(directory, "data.json");
  const content = "héllo 🌍";
  let flags: string | undefined;
  let mode: number | undefined;
  const temporary = stageAtomicFile(path, content, {
    mode: 0o600,
    operations: {
      open: (candidate, openFlags, openMode) => {
        expect(dirname(candidate)).toBe(directory);
        flags = openFlags;
        mode = openMode;
        return openSync(candidate, openFlags, openMode);
      },
      write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, Math.min(2, length)),
      fsync: () => { throw new Error("fsync should be disabled"); },
    },
  });

  expect(flags).toBe("wx");
  expect(mode).toBe(0o600);
  expect(readFileSync(temporary, "utf8")).toBe(content);
  commitAtomicFile(temporary, path);
  expect(readFileSync(path, "utf8")).toBe(content);
  expect(existsSync(temporary)).toBe(false);
});

test("staging keeps the write error primary and cleans up after invalid write counts", () => {
  const directory = temporaryRoot();
  const path = join(directory, "data.json");
  let temporary: string | undefined;
  const closeFailure = new Error("injected close failure");
  let caught: unknown;

  try {
    stageAtomicFile(path, "contents", {
      mode: 0o600,
      operations: {
        open: (candidate, flags, mode) => {
          temporary = candidate;
          return openSync(candidate, flags, mode);
        },
        write: () => 0,
        close: (fd) => {
          closeSync(fd);
          throw closeFailure;
        },
        remove: (candidate) => {
          rmSync(candidate, { force: true });
          throw new Error("injected cleanup failure");
        },
      },
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain("Unable to complete staging write");
  expect(caught).not.toBe(closeFailure);
  expect(temporary && existsSync(temporary)).toBe(false);
  expect(readdirSync(directory)).toEqual([]);
});

test("fsync and mode preservation are explicit one-shot replacement policies", () => {
  const directory = temporaryRoot();
  const path = join(directory, "consent.json");
  writeFileSync(path, "old");
  chmodSync(path, 0o640);
  let synced = false;
  const publishOrder: string[] = [];

  replaceAtomicFile(path, "new", {
    mode: 0o600,
    preserveExistingMode: true,
    fsync: true,
    exactMode: true,
    operations: {
      fsync: (fd) => {
        synced = true;
        fsyncSync(fd);
      },
      chmod: (candidate, mode) => {
        publishOrder.push(candidate.includes(".tmp-") ? "chmod-temp" : "chmod-published");
        chmodSync(candidate, mode);
      },
      rename: (from, to) => {
        publishOrder.push("rename");
        renameSync(from, to);
      },
    },
  });

  expect(synced).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("new");
  expect(statSync(path).mode & 0o777).toBe(0o640);
  expect(publishOrder).toEqual(["chmod-temp", "rename"]);
});

test("durable exact-mode replacement follows the required publish order", () => {
  const calls: string[] = [];

  replaceAtomicFile("/run/data.json", "value", {
    mode: 0o640,
    fsync: true,
    exactMode: true,
    syncParentDirectory: true,
    operations: {
      open: () => {
        calls.push("open");
        return 42;
      },
      write: (_fd, _buffer, _offset, length) => {
        calls.push("write");
        return Math.min(2, length);
      },
      chmod: () => { calls.push("chmod"); },
      fsync: () => { calls.push("fsync"); },
      close: () => { calls.push("close"); },
      rename: () => { calls.push("rename"); },
      syncDirectory: (path) => {
        expect(path).toBe("/run");
        calls.push("syncDirectory");
      },
    },
  });

  expect(calls).toEqual([
    "open",
    "write",
    "write",
    "write",
    "chmod",
    "fsync",
    "close",
    "rename",
    "syncDirectory",
  ]);
});

test("a chmod failure discards the staging file before publication", () => {
  const directory = temporaryRoot();
  const path = join(directory, "data.json");
  const primary = new Error("injected chmod failure");
  let temporary: string | undefined;
  let caught: unknown;

  try {
    replaceAtomicFile(path, "value", {
      mode: 0o600,
      fsync: true,
      exactMode: true,
      operations: {
        open: (candidate, flags, mode) => {
          temporary = candidate;
          return openSync(candidate, flags, mode);
        },
        chmod: () => { throw primary; },
      },
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(primary);
  expect(temporary && existsSync(temporary)).toBe(false);
  expect(existsSync(path)).toBe(false);
});

test("a parent-directory fsync failure after rename propagates", () => {
  const directory = temporaryRoot();
  const path = join(directory, "data.json");
  const failure = Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });

  expect(() => replaceAtomicFile(path, "value", {
    mode: 0o600,
    fsync: true,
    syncParentDirectory: true,
    operations: {
      syncDirectory: () => { throw failure; },
    },
  })).toThrow(failure);

  expect(readFileSync(path, "utf8")).toBe("value");
});

test("directory sync tolerates only unsupported open or fsync operations", () => {
  const unsupported = Object.assign(new Error("directory fsync unsupported"), { code: "EINVAL" });
  const storageFailure = Object.assign(new Error("storage failed"), { code: "EIO" });
  const closed: number[] = [];

  expect(() => syncDirectoryDurably("/run", {
    open: () => 41,
    fsync: () => { throw unsupported; },
    close: (fd) => { closed.push(fd); },
  })).not.toThrow();
  expect(closed).toEqual([41]);

  expect(() => syncDirectoryDurably("/run", {
    open: () => 42,
    fsync: () => { throw storageFailure; },
    close: (fd) => { closed.push(fd); },
  })).toThrow(storageFailure);
  expect(closed).toEqual([41, 42]);

  expect(() => syncDirectoryDurably("/run", {
    open: () => 43,
    fsync: () => { throw unsupported; },
    close: () => { throw unsupported; },
  })).toThrow(unsupported);
});

test("a file fsync failure propagates and discards the staging file", () => {
  const directory = temporaryRoot();
  const path = join(directory, "data.json");
  const primary = new Error("injected file fsync failure");
  let temporary: string | undefined;
  let directorySyncAttempted = false;
  let caught: unknown;

  try {
    replaceAtomicFile(path, "value", {
      mode: 0o600,
      fsync: true,
      syncParentDirectory: true,
      operations: {
        open: (candidate, flags, mode) => {
          temporary = candidate;
          return openSync(candidate, flags, mode);
        },
        fsync: () => { throw primary; },
        syncDirectory: () => { directorySyncAttempted = true; },
      },
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(primary);
  expect(temporary && existsSync(temporary)).toBe(false);
  expect(existsSync(path)).toBe(false);
  expect(directorySyncAttempted).toBe(false);
});

test("a failed commit keeps its error primary and discards the staging file", () => {
  const directory = temporaryRoot();
  const path = join(directory, "owner.json");
  const temporary = stageAtomicFile(path, "owner", { mode: 0o666 });
  const primary = new Error("injected rename failure");
  let caught: unknown;

  try {
    commitAtomicFile(temporary, path, {
      operations: {
        rename: () => { throw primary; },
        remove: (candidate) => {
          rmSync(candidate, { force: true });
          throw new Error("injected cleanup failure");
        },
      },
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(primary);
  expect(existsSync(temporary)).toBe(false);
  expect(existsSync(path)).toBe(false);
});

test("atomic replacement does not create a missing parent directory", () => {
  const parent = join(temporaryRoot(), "missing");
  expect(() => replaceAtomicFile(join(parent, "data"), "value", { mode: 0o600 })).toThrow();
  expect(existsSync(parent)).toBe(false);
});
