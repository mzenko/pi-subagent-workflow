import { expect, test } from "bun:test";
import { applyLiveWorkflowSettings, globalWorkflowSettings, resolveConcurrentAgentLimit } from "../src/settings/runtime.js";
import { DEFAULT_WORKFLOW_SETTINGS } from "../src/settings/workflow-settings.js";

test("every extension instance shares one process-wide settings store", () => {
  // pi re-evaluates the extension per cwd; module instances share only what
  // is published on globalThis.
  const store = globalWorkflowSettings();
  expect(Object.values(globalThis)).toContain(store);
  expect(globalWorkflowSettings()).toBe(store);
});

test("automatic concurrency retains the documented CPU-aware cap", () => {
  expect(resolveConcurrentAgentLimit("auto", 24)).toBe(16);
  expect(resolveConcurrentAgentLimit("auto", 4)).toBe(2);
  expect(resolveConcurrentAgentLimit("auto", 1)).toBe(1);
  expect(resolveConcurrentAgentLimit(37, 1)).toBe(37);
});

test("live settings apply to the shared runner and session widget", () => {
  const calls: unknown[] = [];
  const runner = {
    setMaxConcurrentAgents: (value: number) => calls.push(["concurrency", value]),
    setAgentTimeoutMinutes: (value: number) => calls.push(["timeout", value]),
  };
  const widget = { configure: (value: unknown) => calls.push(["widget", value]) };
  applyLiveWorkflowSettings({
    ...DEFAULT_WORKFLOW_SETTINGS,
    maxConcurrentAgents: 7,
    agentTimeoutMinutes: 12,
    showStatusWidget: false,
  }, runner as never, widget as never);

  expect(calls).toEqual([
    ["concurrency", 7],
    ["timeout", 12],
    ["widget", false],
  ]);
});
