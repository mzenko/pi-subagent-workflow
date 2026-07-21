import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WORKFLOW_SETTINGS,
  NUMERIC_SETTING_RULES,
  parseSettings,
  WorkflowSettingsStore,
} from "../src/settings/workflow-settings.js";

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "workflow-settings-")), "settings.json");
}

test("missing settings use safe defaults without creating a file", () => {
  const path = tempPath();
  const warnings: string[] = [];
  const store = new WorkflowSettingsStore({ path, warn: (warning) => warnings.push(warning) });
  expect(store.get()).toEqual(DEFAULT_WORKFLOW_SETTINGS);
  expect(warnings).toEqual([]);
  expect(readdirSync(join(path, ".."))).toEqual([]);
});

test("settings changes compose, persist atomically, and use mode 0600", () => {
  const path = tempPath();
  const store = new WorkflowSettingsStore({ path, warn: () => {} });
  store.set("maxConcurrentAgents", 12);
  chmodSync(path, 0o640);
  store.set("workflowApproval", "always-prompt");

  const file = JSON.parse(readFileSync(path, "utf8"));
  expect(file).toMatchObject({ version: 4, maxConcurrentAgents: 12, workflowApproval: "always-prompt" });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(path, "..")).filter((name) => name.startsWith("settings.json.tmp-"))).toEqual([]);

  expect(new WorkflowSettingsStore({ path, warn: () => {} }).get()).toEqual(store.get());
});

test("independent stores rebase mutations instead of losing unrelated changes", () => {
  const path = tempPath();
  const first = new WorkflowSettingsStore({ path, warn: () => {} });
  const stale = new WorkflowSettingsStore({ path, warn: () => {} });

  first.set("maxConcurrentAgents", 3);
  stale.set("agentTimeoutMinutes", 2);

  const reloaded = new WorkflowSettingsStore({ path, warn: () => {} }).get();
  expect(reloaded.maxConcurrentAgents).toBe(3);
  expect(reloaded.agentTimeoutMinutes).toBe(2);
  expect(readdirSync(join(path, ".."))).toContain("settings.json.lock.sqlite");
});

test("settings lock rejects a live owner but recovers after that owner dies", async () => {
  const path = tempPath();
  const store = new WorkflowSettingsStore({ path, warn: () => {} });
  const lockPath = `${path}.lock.sqlite`;
  const ready = `${path}.holder-ready`;
  const sqliteLockUrl = new URL("../src/store/sqlite-lock.ts", import.meta.url).href;
  const holder = Bun.spawn(["bun", "-e", `
    import { writeFileSync } from "node:fs";
    import { withSqliteMutex } from ${JSON.stringify(sqliteLockUrl)};
    withSqliteMutex(${JSON.stringify(lockPath)}, () => {
      writeFileSync(${JSON.stringify(ready)}, "ready");
      while (true) Bun.sleepSync(5);
    });
  `], { stdout: "ignore", stderr: "pipe" });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error("holder never acquired settings lock");
      await Bun.sleep(5);
    }
    expect(() => store.set("agentTimeoutMinutes", 2)).toThrow("another pi process is editing");

    holder.kill();
    await holder.exited;
    expect(store.set("agentTimeoutMinutes", 2).agentTimeoutMinutes).toBe(2);
    expect(existsSync(lockPath)).toBe(true);
  } finally {
    holder.kill();
    await holder.exited;
  }
});

test("invalid files fail safely to defaults with a contextual warning", () => {
  const path = tempPath();
  writeFileSync(path, "{ broken");
  const warnings: string[] = [];
  const store = new WorkflowSettingsStore({ path, warn: (warning) => warnings.push(warning) });
  expect(store.get()).toEqual(DEFAULT_WORKFLOW_SETTINGS);
  expect(store.getWarning()).toContain(path);
  expect(store.getWarning()).toContain("invalid JSON");
  expect(warnings).toEqual([store.getWarning()!]);
});

test("a broken warning sink cannot defeat safe-default loading", () => {
  const path = tempPath();
  writeFileSync(path, "invalid");
  expect(() => new WorkflowSettingsStore({ path, warn: () => { throw new Error("logger closed"); } })).not.toThrow();
});

test("strict parsing rejects unknown, missing, and out-of-range settings", () => {
  const valid = { version: 4, ...DEFAULT_WORKFLOW_SETTINGS };
  expect(() => parseSettings(JSON.stringify({ ...valid, surprise: true }))).toThrow("exactly");
  const { showStatusWidget: _, ...missing } = valid;
  expect(() => parseSettings(JSON.stringify(missing))).toThrow("exactly");
  expect(() => parseSettings(JSON.stringify({ ...valid, agentTimeoutMinutes: 241 }))).toThrow("1 to 240");
  expect(() => parseSettings(JSON.stringify({ ...valid, version: 2 }))).toThrow("unsupported settings version");
});

test("reload and reset notify subscribers with immutable snapshots", () => {
  const path = tempPath();
  const store = new WorkflowSettingsStore({ path, warn: () => {} });
  store.set("agentTimeoutMinutes", 3);
  const seen: number[] = [];
  const unsubscribe = store.subscribe((settings) => {
    seen.push(settings.agentTimeoutMinutes);
    (settings as { agentTimeoutMinutes: number }).agentTimeoutMinutes = 99;
  });

  writeFileSync(path, `${JSON.stringify({ version: 4, ...DEFAULT_WORKFLOW_SETTINGS, agentTimeoutMinutes: 5 })}\n`);
  store.reload();
  expect(store.get().agentTimeoutMinutes).toBe(5);
  store.reset();
  expect(store.get()).toEqual(DEFAULT_WORKFLOW_SETTINGS);
  expect(seen).toEqual([5, 0]);
  unsubscribe();
});



test("a failed save does not change effective settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-settings-dir-"));
  const store = new WorkflowSettingsStore({ path: directory, warn: () => {} });
  const before = store.get();
  expect(() => store.set("agentTimeoutMinutes", 2)).toThrow("Cannot save workflow settings");
  expect(store.get()).toEqual(before);
});

test("valid version 2 files migrate once and preserve surviving settings", () => {
  const path = tempPath();
  const v2 = {
    version: 2,
    maxConcurrentAgents: 3,
    workflowApproval: "always-prompt",
    maxAgentsPerWorkflow: 17,
    agentTimeoutMinutes: 40,
    warmSessionLimit: 4,
    showStatusWidget: false,
    statusWidgetMaxRows: 2,
    childExtensionExclusions: ["old-extension"],
  };
  writeFileSync(path, `${JSON.stringify(v2)}\n`);
  const warnings: string[] = [];
  const store = new WorkflowSettingsStore({ path, warn: (warning) => warnings.push(warning) });

  const expected = {
    maxConcurrentAgents: 3,
    workflowApproval: "always-prompt",
    agentTimeoutMinutes: 40,
    showStatusWidget: false,
  } as const;
  expect(store.get()).toEqual(expected);
  expect(store.getWarning()).toBeUndefined();
  expect(warnings).toEqual([`Workflow settings at ${path} were migrated from v2 to v4.`]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 4, ...expected });

  const secondWarnings: string[] = [];
  const second = new WorkflowSettingsStore({ path, warn: (warning) => secondWarnings.push(warning) });
  expect(second.get()).toEqual(expected);
  expect(second.getWarning()).toBeUndefined();
  expect(secondWarnings).toEqual([]);
});

test("version 2 files with invalid surviving settings do not migrate", () => {
  const path = tempPath();
  const v2 = {
    version: 2,
    maxConcurrentAgents: "auto",
    workflowApproval: "bogus",
    maxAgentsPerWorkflow: 200,
    agentTimeoutMinutes: 0,
    warmSessionLimit: 8,
    showStatusWidget: true,
    statusWidgetMaxRows: 6,
    childExtensionExclusions: [],
  };
  const original = `${JSON.stringify(v2)}\n`;
  writeFileSync(path, original);
  const warnings: string[] = [];

  const store = new WorkflowSettingsStore({ path, warn: (warning) => warnings.push(warning) });

  expect(store.get()).toEqual(DEFAULT_WORKFLOW_SETTINGS);
  expect(warnings).toEqual([store.getWarning()!]);
  expect(store.getWarning()).toContain("found file version 2");
  expect(readFileSync(path, "utf8")).toBe(original);
});

test.each([
  ["missing", (value: Record<string, unknown>) => { delete value.warmSessionLimit; }],
  ["extra", (value: Record<string, unknown>) => { value.surprise = true; }],
])("version 2 files with a %s key do not migrate", (_case, alter) => {
  const path = tempPath();
  const v2: Record<string, unknown> = {
    version: 2,
    maxConcurrentAgents: "auto",
    workflowApproval: "auto",
    maxAgentsPerWorkflow: 200,
    agentTimeoutMinutes: 0,
    warmSessionLimit: 8,
    showStatusWidget: true,
    statusWidgetMaxRows: 6,
    childExtensionExclusions: [],
  };
  alter(v2);
  const original = `${JSON.stringify(v2)}\n`;
  writeFileSync(path, original);
  const warnings: string[] = [];

  const store = new WorkflowSettingsStore({ path, warn: (warning) => warnings.push(warning) });

  expect(store.get()).toEqual(DEFAULT_WORKFLOW_SETTINGS);
  expect(warnings).toEqual([store.getWarning()!]);
  expect(store.getWarning()).toContain("found file version 2");
  expect(readFileSync(path, "utf8")).toBe(original);
});

test.each([1, "garbage"])("version %p retains the existing warning behavior", (version) => {
  const path = tempPath();
  const original = `${JSON.stringify({ version, ...DEFAULT_WORKFLOW_SETTINGS })}\n`;
  writeFileSync(path, original);
  const warnings: string[] = [];

  const store = new WorkflowSettingsStore({ path, warn: (warning) => warnings.push(warning) });

  expect(store.get()).toEqual(DEFAULT_WORKFLOW_SETTINGS);
  expect(warnings).toEqual([store.getWarning()!]);
  expect(store.getWarning()).toContain(`found file version ${JSON.stringify(version)}`);
  expect(readFileSync(path, "utf8")).toBe(original);
});

test("valid version 3 files migrate once, dropping childExtensionExclusions", () => {
  const path = tempPath();
  const v3 = {
    version: 3,
    maxConcurrentAgents: 7,
    workflowApproval: "remember",
    agentTimeoutMinutes: 15,
    showStatusWidget: true,
    childExtensionExclusions: ["pi-web-access"],
  };
  writeFileSync(path, `${JSON.stringify(v3)}\n`);
  const warnings: string[] = [];
  const store = new WorkflowSettingsStore({ path, warn: (warning) => warnings.push(warning) });

  const expected = { maxConcurrentAgents: 7, workflowApproval: "remember", agentTimeoutMinutes: 15, showStatusWidget: true } as const;
  expect(store.get()).toEqual(expected);
  expect(warnings).toEqual([`Workflow settings at ${path} were migrated from v3 to v4.`]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 4, ...expected });
});

test("legacy files with a malformed deleted key do not migrate and are left unchanged", () => {
  const path = tempPath();
  const original = `${JSON.stringify({
    version: 3,
    maxConcurrentAgents: "auto",
    workflowApproval: "remember",
    agentTimeoutMinutes: 0,
    showStatusWidget: true,
    childExtensionExclusions: "not-an-array",
  })}\n`;
  writeFileSync(path, original);
  const warnings: string[] = [];

  const store = new WorkflowSettingsStore({ path, warn: (warning) => warnings.push(warning) });

  expect(store.get()).toEqual(DEFAULT_WORKFLOW_SETTINGS);
  expect(store.getWarning()).toContain("found file version 3");
  expect(readFileSync(path, "utf8")).toBe(original);
});

test("version 3 files with unknown keys do not migrate and are left unchanged", () => {
  const path = tempPath();
  const original = `${JSON.stringify({ version: 3, ...DEFAULT_WORKFLOW_SETTINGS, childExtensionExclusions: [], unknownSetting: true })}\n`;
  writeFileSync(path, original);
  const warnings: string[] = [];

  const store = new WorkflowSettingsStore({ path, warn: (warning) => warnings.push(warning) });

  expect(store.get()).toEqual(DEFAULT_WORKFLOW_SETTINGS);
  expect(warnings).toEqual([store.getWarning()!]);
  expect(store.getWarning()).toContain("found file version 3");
  expect(readFileSync(path, "utf8")).toBe(original);
});

test("v4 files with unknown keys fail closed and refuse edits without being rewritten", () => {
  const path = tempPath();
  const original = `${JSON.stringify({ version: 4, ...DEFAULT_WORKFLOW_SETTINGS, maxConcurrentAgents: 7, unknownSetting: true })}\n`;
  writeFileSync(path, original);
  const warnings: string[] = [];

  const store = new WorkflowSettingsStore({ path, warn: (warning) => warnings.push(warning) });

  expect(store.get()).toEqual(DEFAULT_WORKFLOW_SETTINGS);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(`Cannot load workflow settings at ${path}`);
  expect(warnings[0]).toContain("settings must contain exactly");
  expect(warnings[0]).toContain("Using safe defaults");
  expect(warnings[0]).not.toContain("schema changed");
  expect(() => store.set("agentTimeoutMinutes", 5)).toThrow("Cannot save workflow settings");
  expect(store.get()).toEqual(DEFAULT_WORKFLOW_SETTINGS);
  expect(readFileSync(path, "utf8")).toBe(original);
});


test("numeric setting rules are deeply frozen and cannot change parsing behavior", () => {
  expect(Object.isFrozen(NUMERIC_SETTING_RULES)).toBe(true);
  for (const rule of Object.values(NUMERIC_SETTING_RULES)) expect(Object.isFrozen(rule)).toBe(true);

  expect(() => (NUMERIC_SETTING_RULES.agentTimeoutMinutes as { max: number }).max = 2).toThrow();
  expect(NUMERIC_SETTING_RULES.agentTimeoutMinutes.max).toBe(240);
  const valid = { version: 4, ...DEFAULT_WORKFLOW_SETTINGS };
  expect(() => parseSettings(JSON.stringify({ ...valid, agentTimeoutMinutes: 240 }))).not.toThrow();
  expect(() => parseSettings(JSON.stringify({ ...valid, agentTimeoutMinutes: 241 }))).toThrow(
    "agentTimeoutMinutes must be an integer from 1 to 240",
  );
});

test("numeric setting rules preserve all store boundaries and sentinels", () => {
  expect(NUMERIC_SETTING_RULES).toEqual({
    maxConcurrentAgents: { min: 1, max: 64, sentinel: "auto" },
    agentTimeoutMinutes: { min: 1, max: 240, sentinel: 0 },
  });
  const valid = { version: 4, ...DEFAULT_WORKFLOW_SETTINGS };
  for (const [key, values] of Object.entries({
    maxConcurrentAgents: ["auto", 1, 64],
    agentTimeoutMinutes: [0, 1, 240],
  })) {
    for (const value of values) {
      expect(() => parseSettings(JSON.stringify({ ...valid, [key]: value }))).not.toThrow();
    }
  }
  for (const [key, values] of Object.entries({
    maxConcurrentAgents: [0, 65],
    agentTimeoutMinutes: [-1, 241],
  })) {
    for (const value of values) {
      expect(() => parseSettings(JSON.stringify({ ...valid, [key]: value }))).toThrow();
    }
  }
});
