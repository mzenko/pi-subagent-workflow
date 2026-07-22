import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  confirmAutoApproval,
  formatSettings,
  handleSettingsCommand,
  parseNumericSetting,
  registerWorkflowSettingsCommands,
  settingsItems,
} from "../src/settings/commands.js";
import { DEFAULT_WORKFLOW_SETTINGS, WorkflowSettingsStore } from "../src/settings/workflow-settings.js";
import { ConsentStore } from "../src/workflow/consent.js";

function store(): WorkflowSettingsStore {
  return new WorkflowSettingsStore({
    path: join(mkdtempSync(join(tmpdir(), "workflow-settings-command-")), "settings.json"),
    warn: () => {},
  });
}

function services(settings: WorkflowSettingsStore, clearApprovals = () => {}): Parameters<typeof handleSettingsCommand>[2] {
  return { settings, clearApprovals };
}

function context(overrides: Record<string, unknown> = {}): any {
  return {
    mode: "tui",
    ui: {
      notify: () => {},
      confirm: async () => false,
      input: async () => undefined,
      ...overrides,
    },
  };
}

test("registers the workflow settings command and subagent alias", () => {
  const commands = new Map<string, unknown>();
  registerWorkflowSettingsCommands({
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
  } as never, services(store()));
  expect([...commands.keys()]).toEqual(["workflow-settings", "subagent-settings"]);
});

test("settings list contains all approved fields and maintenance actions", () => {
  const items = settingsItems(DEFAULT_WORKFLOW_SETTINGS);
  expect(items.map((item) => item.id)).toEqual([
    "maxConcurrentAgents",
    "workflowApproval",
    "agentTimeoutMinutes",
    "showStatusWidget",
    "action:reload",
    "action:clear-approvals",
    "action:reset",
  ]);
  expect(items.find((item) => item.id === "agentTimeoutMinutes")?.submenu).toBeFunction();
  expect(items.find((item) => item.id === "workflowApproval")?.submenu).toBeFunction();
});

test("finite settings show an explicit option list", () => {
  initTheme(undefined, false);
  const items = settingsItems(DEFAULT_WORKFLOW_SETTINGS);
  const approval = items.find((item) => item.id === "workflowApproval")!;
  let selected: string | undefined;
  const menu = approval.submenu!(approval.currentValue, (value) => { selected = value; });
  const rendered = menu.render(80).join("\n");
  expect(rendered).toContain("Always prompt");
  expect(rendered).toContain("Remember approvals");
  expect(rendered).toContain("Auto-approve");

  // The current "remember" option is preselected. Move to auto and choose it.
  menu.handleInput?.("\u001b[B");
  menu.handleInput?.("\r");
  expect(selected).toBe("auto");

  const numeric = items.find((item) => item.id === "maxConcurrentAgents")!;
  const numericMenu = numeric.submenu!(numeric.currentValue, () => {});
  expect(numericMenu.render(80).join("\n")).toContain("Enter a value");
  expect(numericMenu.render(80).join("\n")).toContain("Automatic");
});

test("numeric settings accept documented boundaries and sentinels and reject invalid input", () => {
  expect(parseNumericSetting("maxConcurrentAgents", "AUTO")).toBe("auto");
  expect(parseNumericSetting("maxConcurrentAgents", "1")).toBe(1);
  expect(parseNumericSetting("maxConcurrentAgents", "64")).toBe(64);
  expect(parseNumericSetting("agentTimeoutMinutes", "0")).toBe(0);
  expect(parseNumericSetting("agentTimeoutMinutes", "240")).toBe(240);
  expect(() => parseNumericSetting("maxConcurrentAgents", "0")).toThrow("1 to 64");
  expect(() => parseNumericSetting("agentTimeoutMinutes", "-1")).toThrow("1 to 240");
  expect(() => parseNumericSetting("agentTimeoutMinutes", "241")).toThrow("1 to 240");
  expect(() => parseNumericSetting("agentTimeoutMinutes", "auto")).toThrow("1 to 240");
  expect(() => parseNumericSetting("agentTimeoutMinutes", "3.5")).toThrow("1 to 240");
});

test("numeric settings display their canonical ranges and sentinels", () => {
  initTheme(undefined, false);
  const items = settingsItems(DEFAULT_WORKFLOW_SETTINGS);
  const expected = {
    maxConcurrentAgents: "Enter an integer from 1 to 64, or auto",
    agentTimeoutMinutes: "Enter an integer from 1 to 240, or 0 to disable",
  } as const;
  for (const [id, range] of Object.entries(expected)) {
    const item = items.find((candidate) => candidate.id === id)!;
    expect(item.submenu!(item.currentValue, () => {}).render(100).join("\n")).toContain(range);
  }
});

test("auto approval uses a confirmation dialog instead of typed text", async () => {
  expect(await confirmAutoApproval(context({ confirm: async () => true }))).toBe(true);
  expect(await confirmAutoApproval(context({ confirm: async () => false }))).toBe(false);
});

test("show reports effective values and path", async () => {
  const settings = store();
  settings.set("maxConcurrentAgents", 9);
  const notifications: Array<[string, string]> = [];
  await handleSettingsCommand("show", context({ notify: (text: string, type: string) => notifications.push([text, type]) }), services(settings));
  expect(notifications).toHaveLength(1);
  expect(notifications[0]![0]).toContain(settings.path);
  expect(notifications[0]![0]).toContain("maxConcurrentAgents: 9");
  expect(notifications[0]![1]).toBe("info");
  expect(formatSettings(settings)).toContain("workflowApproval: remember");
});

test("interactive settings list edits numeric fields through a focused input", async () => {
  initTheme(undefined, false);
  const settings = store();
  let overlays = 0;
  const ctx = context({
    input: async () => "12",
    custom: async (factory: any) => {
      overlays += 1;
      if (overlays > 1) return undefined;
      let result: unknown;
      const component = await factory(
        { requestRender: () => {} },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        {},
        (value: unknown) => { result = value; },
      );
      component.handleInput("\r"); // Open the setting's explicit choice list.
      component.handleInput("\r"); // Choose "Enter a value".
      return result;
    },
  });
  await handleSettingsCommand("", ctx, services(settings));
  expect(settings.get().maxConcurrentAgents).toBe(12);
  expect(overlays).toBe(2);
});

test("interactive numeric sentinel selection applies auto without a text prompt", async () => {
  initTheme(undefined, false);
  const settings = store();
  settings.set("maxConcurrentAgents", 9);
  let overlays = 0;
  let inputCalls = 0;
  const ctx = context({
    input: async () => { inputCalls += 1; return undefined; },
    custom: async (factory: any) => {
      overlays += 1;
      if (overlays > 1) return undefined;
      let result: unknown;
      const component = await factory(
        { requestRender: () => {} },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        {},
        (value: unknown) => { result = value; },
      );
      component.handleInput("\r"); // Open the setting's explicit choice list.
      component.handleInput("\u001b[B"); // Automatic.
      component.handleInput("\r");
      return result;
    },
  });

  await handleSettingsCommand("", ctx, services(settings));

  expect(settings.get().maxConcurrentAgents).toBe("auto");
  expect(inputCalls).toBe(0);
  expect(overlays).toBe(2);
});

test("interactive enum selection requires no typed value", async () => {
  initTheme(undefined, false);
  const settings = store();
  let overlays = 0;
  let inputCalls = 0;
  const ctx = context({
    confirm: async () => true,
    input: async () => { inputCalls += 1; return undefined; },
    custom: async (factory: any) => {
      overlays += 1;
      if (overlays > 1) return undefined;
      let result: unknown;
      const component = await factory(
        { requestRender: () => {} },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        {},
        (value: unknown) => { result = value; },
      );
      component.handleInput("\u001b[B"); // Workflow approval.
      component.handleInput("\r"); // Open explicit choices at "remember".
      component.handleInput("\u001b[B"); // Auto-approve.
      component.handleInput("\r");
      return result;
    },
  });
  await handleSettingsCommand("", ctx, services(settings));
  expect(settings.get().workflowApproval).toBe("auto");
  expect(inputCalls).toBe(0);
});

test("settings dialog lines never exceed the render width, including the schema warning", async () => {
  initTheme(undefined, false);
  // A long path plus an unsupported-version file produces the widest header
  // the dialog can render: the ~230-column reset warning that crashed pi-tui.
  const dir = mkdtempSync(join(tmpdir(), "workflow-settings-width-padded-to-make-the-settings-path-long-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, `${JSON.stringify({ version: 5, maxConcurrentAgents: 4 })}\n`);
  const settings = new WorkflowSettingsStore({ path, warn: () => {} });
  expect(settings.getWarning()).toContain("found file version 5");

  const rendered: string[][] = [];
  const ctx = context({
    custom: async (factory: any) => {
      const component = await factory(
        { requestRender: () => {} },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        {},
        () => {},
      );
      for (const width of [172, 40]) rendered.push(component.render(width).map((line: string) => ({ line, width })));
      component.handleInput(""); // Escape closes the dialog.
      return undefined;
    },
  });
  await handleSettingsCommand("", ctx, services(settings));

  expect(rendered).toHaveLength(2);
  for (const frame of rendered) {
    for (const { line, width } of frame as unknown as Array<{ line: string; width: number }>) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  }
  // The warning survives wrapping: its content is spread across lines rather than cut.
  const joined = (rendered[0] as unknown as Array<{ line: string }>).map(({ line }) => line).join(" ");
  expect(joined).toContain("found file version 5");
  expect(joined).toContain("left unchanged");
});

test("reset and clear approvals require confirmation", async () => {
  const settings = store();
  settings.set("agentTimeoutMinutes", 1);
  const consent = new ConsentStore(join(mkdtempSync(join(tmpdir(), "workflow-consent-clear-")), "consent.json"));
  consent.record("flow", "/work", "hash");
  const clearApprovals = () => consent.clear();
  await handleSettingsCommand("reset", context({ confirm: async () => true }), services(settings, clearApprovals));
  expect(settings.get().agentTimeoutMinutes).toBe(DEFAULT_WORKFLOW_SETTINGS.agentTimeoutMinutes);
  await handleSettingsCommand("clear-approvals", context({ confirm: async () => true }), services(settings, clearApprovals));
  expect(consent.isApproved("flow", "/work", "hash")).toBe(false);
});
