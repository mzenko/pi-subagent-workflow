import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentWorkflow from "../extensions/subagent-workflow.js";
import { subagentRunner } from "../src/runner/runner.js";

test("background command and navigator shortcut register with guarded behavior", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
  const shortcuts = new Map<string, { handler: (ctx: unknown) => Promise<void> | void }>();
  const methods: Record<string, (...args: any[]) => unknown> = {
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => {
      commands.set(name, command);
    },
    registerShortcut: (key: string, shortcut: { handler: (ctx: unknown) => Promise<void> | void }) => {
      shortcuts.set(key, shortcut);
    },
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

  const runId = "cmd-run-1";
  const notices: string[] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => { notices.push(message); } },
    sessionManager: { getSessionId: () => "cmd-test" },
  };

  subagentRunner.registerWaitedRun(runId, "cmd-test", () => true);
  try {
    const background = commands.get("background");
    expect(background).toBeDefined();

    await background!.handler("", ctx);
    expect(notices).toEqual([`Backgrounded ${runId}; results will arrive as steered messages`]);

    await background!.handler("", ctx);
    expect(notices).toEqual([
      `Backgrounded ${runId}; results will arrive as steered messages`,
      "No waited runs to background",
    ]);
  } finally {
    subagentRunner.unregisterWaitedRun(runId);
  }
});
