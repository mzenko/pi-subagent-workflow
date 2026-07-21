import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsentStore } from "../src/workflow/consent.js";

const HASH = "script-hash-a";

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "consent-")), "consent.json");
}

test("records and reads approval per (workflow, cwd, script hash)", () => {
  const store = new ConsentStore(tempPath(), () => new Date("2026-07-11T00:00:00Z"));
  expect(store.isApproved("audit-routes", "/work", HASH)).toBe(false);
  store.record("audit-routes", "/work", HASH);
  expect(store.isApproved("audit-routes", "/work", HASH)).toBe(true);
  // Different workflow, project, or script contents do not inherit consent.
  expect(store.isApproved("audit-routes", "/other", HASH)).toBe(false);
  expect(store.isApproved("other-flow", "/work", HASH)).toBe(false);
  expect(store.isApproved("audit-routes", "/work", "script-hash-b")).toBe(false);
});

test("consent survives a fresh store at the same path and is de-duplicated", () => {
  const path = tempPath();
  const first = new ConsentStore(path, () => new Date("2026-07-11T00:00:00Z"));
  first.record("audit-routes", "/work", HASH);
  first.record("audit-routes", "/work", HASH);
  const file = JSON.parse(readFileSync(path, "utf8")) as { approvals: unknown[] };
  expect(file.approvals).toHaveLength(1);
  const second = new ConsentStore(path);
  expect(second.isApproved("audit-routes", "/work", HASH)).toBe(true);
});

test("cwd is compared after resolution so equivalent paths match", () => {
  const store = new ConsentStore(tempPath());
  store.record("flow", "/work/proj", HASH);
  expect(store.isApproved("flow", "/work/proj/", HASH)).toBe(true);
  expect(store.isApproved("flow", "/work/./proj", HASH)).toBe(true);
});

test("a corrupt consent file is treated as empty, not a crash", () => {
  const path = tempPath();
  writeFileSync(path, "not json");
  const store = new ConsentStore(path);
  expect(store.isApproved("flow", "/work", HASH)).toBe(false);
  store.record("flow", "/work", HASH);
  expect(store.isApproved("flow", "/work", HASH)).toBe(true);
});

test("legacy hashless records do not approve changed or unknown script contents", () => {
  const path = tempPath();
  writeFileSync(path, JSON.stringify({
    version: 1,
    approvals: [{ workflow: "flow", cwd: "/work", grantedAt: "2026-01-01T00:00:00.000Z" }],
  }));
  expect(new ConsentStore(path).isApproved("flow", "/work", HASH)).toBe(false);
});

test("clear forgets every grant while record keeps prior grants", () => {
  const path = tempPath();
  const store = new ConsentStore(path);
  store.record("flow-a", "/work", HASH);
  store.record("flow-b", "/work", HASH);
  expect(store.isApproved("flow-a", "/work", HASH)).toBe(true);
  expect(store.isApproved("flow-b", "/work", HASH)).toBe(true);

  store.clear();
  expect(store.isApproved("flow-a", "/work", HASH)).toBe(false);
  expect(store.isApproved("flow-b", "/work", HASH)).toBe(false);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2, approvals: [] });

  // A grant after a clear does not resurrect the cleared entries.
  store.record("flow-c", "/work", HASH);
  expect(store.isApproved("flow-a", "/work", HASH)).toBe(false);
  expect(store.isApproved("flow-c", "/work", HASH)).toBe(true);
});

test("a record committed while the lock is held blocks briefly, then succeeds", async () => {
  const path = tempPath();
  const store = new ConsentStore(path);
  store.record("seed", "/work", HASH);
  const lockPath = `${path}.lock.sqlite`;
  const sqliteLockUrl = new URL("../src/store/sqlite-lock.ts", import.meta.url).href;
  const holder = Bun.spawn(["bun", "-e", `
    import { writeFileSync } from "node:fs";
    import { withSqliteMutex } from ${JSON.stringify(sqliteLockUrl)};
    withSqliteMutex(${JSON.stringify(lockPath)}, () => {
      writeFileSync(${JSON.stringify(`${path}.ready`)}, "ready");
      Bun.sleepSync(120);
    });
  `], { stdout: "ignore", stderr: "pipe" });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(`${path}.ready`)) {
      if (Date.now() >= deadline) throw new Error("holder never armed the lock");
      await Bun.sleep(5);
    }
    // The lock is held; record waits it out and the seed grant survives.
    store.record("contended", "/work", HASH);
    expect(store.isApproved("seed", "/work", HASH)).toBe(true);
    expect(store.isApproved("contended", "/work", HASH)).toBe(true);
  } finally {
    holder.kill();
    await holder.exited;
  }
});

test("concurrent processes recording distinct grants never lose an update", async () => {
  const path = tempPath();
  const moduleUrl = new URL("../src/workflow/consent.ts", import.meta.url).href;
  const ids = [0, 1, 2, 3, 4];
  const child = (id: number): string => `
    import { existsSync, writeFileSync } from "node:fs";
    import { ConsentStore } from ${JSON.stringify(moduleUrl)};
    const path = ${JSON.stringify(path)};
    const id = ${id};
    const store = new ConsentStore(path);
    writeFileSync(path + ".ready-" + id, "ready");
    while (!existsSync(path + ".go")) await Bun.sleep(5);
    store.record("flow-" + id, "/work", "hash-" + id);
  `;
  const processes = ids.map((id) => Bun.spawn(["bun", "-e", child(id)], { stdout: "ignore", stderr: "pipe" }));
  try {
    const deadline = Date.now() + 5_000;
    while (!ids.every((id) => existsSync(`${path}.ready-${id}`))) {
      if (Date.now() >= deadline) throw new Error("children never armed");
      await Bun.sleep(5);
    }
    writeFileSync(`${path}.go`, "go");
    await Promise.all(processes.map((process) => process.exited));
  } finally {
    for (const process of processes) process.kill();
    await Promise.all(processes.map((process) => process.exited));
  }
  const store = new ConsentStore(path);
  for (const id of ids) {
    expect(store.isApproved(`flow-${id}`, "/work", `hash-${id}`)).toBe(true);
  }
});

test("atomic commit preserves the file's existing permissions", () => {
  const path = tempPath();
  const store = new ConsentStore(path);
  store.record("flow", "/work", HASH);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  chmodSync(path, 0o640);
  store.record("flow-two", "/work", HASH);
  expect(statSync(path).mode & 0o777).toBe(0o640);
});
