import { expect, test } from "bun:test";
import { normalizeWorkflowToolArgs, resolveScriptSource } from "../src/workflow/workflow-tool.js";

const services = {
  resolveSaved: (name: string, _cwd: string): string | undefined =>
    name === "audit-routes" ? "export const meta = { name: 'audit-routes', description: 'x' };" : undefined,
};

test("@<name> resolves to a saved workflow with origin saved", () => {
  const resolved = resolveScriptSource({ script: "@audit-routes" }, "/work", services);
  expect(resolved.origin).toBe("saved");
  expect(resolved.script).toContain("name: 'audit-routes'");
});

test("@<name> whitespace is tolerated", () => {
  expect(resolveScriptSource({ script: "  @audit-routes  " }, "/work", services).origin).toBe("saved");
});

test("an unknown @<name> is a clear error", () => {
  expect(() => resolveScriptSource({ script: "@missing" }, "/work", services)).toThrow('No saved workflow named "missing"');
});

test("a literal script is treated as inline", () => {
  const resolved = resolveScriptSource({ script: "export const meta = { name: 'x', description: 'y' };" }, "/work", services);
  expect(resolved.origin).toBe("inline");
});

test("exactly one of script or scriptPath is required", () => {
  expect(() => resolveScriptSource({ resumeRunId: "workflow-1" }, "/work", services))
    .toThrow("resumeRunId does not replace the script");
  expect(() => resolveScriptSource({ script: "x", scriptPath: "/y" }, "/work", services)).toThrow("exactly one");
});

test("omitted tool args remain undefined so a recovery launch reloads persisted args", () => {
  expect(normalizeWorkflowToolArgs(undefined)).toBeUndefined();
  expect(normalizeWorkflowToolArgs("{\"value\":1}")).toEqual({ value: 1 });
  expect(normalizeWorkflowToolArgs(null)).toBeNull();
});
