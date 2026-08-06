import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentWorkflow from "../extensions/subagent-workflow.js";

test("the navigator shortcut registers and declines to open without a UI", async () => {
  const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> | void }>();
  const methods: Record<string, (...args: any[]) => unknown> = {
    registerShortcut: (key: string, shortcut: { handler: (ctx: unknown) => Promise<void> | void }) => {
      shortcuts.set(key, shortcut);
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    registerEntryRenderer: () => undefined,
    on: () => undefined,
  };
  const pi = new Proxy(methods, {
    get: (target, property) => target[String(property)] ?? (() => undefined),
  }) as unknown as ExtensionAPI;
  subagentWorkflow(pi);

  let customCalls = 0;
  const shortcut = shortcuts.get("shift+down");
  expect(shortcut).toBeDefined();
  await shortcut!.handler({ hasUI: false, ui: { custom: () => { customCalls += 1; } } });
  expect(customCalls).toBe(0);
});
