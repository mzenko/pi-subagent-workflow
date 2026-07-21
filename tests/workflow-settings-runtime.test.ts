import { expect, test } from "bun:test";
import { applyLiveWorkflowSettings, globalWorkflowSettings, resolveConcurrentAgentLimit } from "../src/settings/runtime.js";
import { DEFAULT_WORKFLOW_SETTINGS } from "../src/settings/workflow-settings.js";

test("settings hot reload ignores the old v3 process singleton", () => {
  const oldKey = "__piSubagentWorkflowSettings_v3__";
  const currentKey = "__piSubagentWorkflowSettings_v4__";
  const scope = globalThis as unknown as Record<string, unknown>;
  const previousOld = scope[oldKey];
  const previousCurrent = scope[currentKey];
  const sentinel = {};
  scope[oldKey] = sentinel;
  delete scope[currentKey];
  try {
    const store = globalWorkflowSettings();
    expect(store).not.toBe(sentinel);
    expect(scope[currentKey]).toBe(store);
    expect(scope[oldKey]).toBe(sentinel);
  } finally {
    if (previousOld === undefined) delete scope[oldKey];
    else scope[oldKey] = previousOld;
    if (previousCurrent === undefined) delete scope[currentKey];
    else scope[currentKey] = previousCurrent;
  }
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
