import { expect, test } from "bun:test";
import { CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentWorkflow from "../extensions/subagent-workflow.js";

test("/work autocompletes to /workflows before sibling workflow commands", async () => {
  const commands: SlashCommand[] = [];
  const methods: Record<string, (...args: any[]) => unknown> = {
    registerCommand: (name: string, command: { description?: string }) => {
      commands.push({ name, description: command.description });
    },
    registerTool: () => undefined,
    registerEntryRenderer: () => undefined,
    on: () => undefined,
  };
  const pi = new Proxy(methods, {
    get: (target, property) => target[String(property)] ?? (() => undefined),
  }) as unknown as ExtensionAPI;

  subagentWorkflow(pi);

  expect(commands.filter((command) => command.name.startsWith("work")).map((command) => command.name)).toEqual([
    "workflows",
    "workflow-save",
    "workflow-settings",
  ]);

  const provider = new CombinedAutocompleteProvider(commands, process.cwd());
  const suggestions = await provider.getSuggestions(["/work"], 0, 5, {
    signal: new AbortController().signal,
  });
  expect(suggestions?.items[0]?.value).toBe("workflows");
});
