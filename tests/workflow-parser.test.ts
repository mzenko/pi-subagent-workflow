import { expect, test } from "bun:test";
import { parseWorkflowScript } from "../src/workflow/parser.js";

test("workflow parser retains the exact script while extracting meta and VM body", () => {
  const script = "export const meta = { name: 'audit-routes', description: 'Audit', phases: [{ title: 'Find' }] };\r\n// ü\r\nreturn 1\r\n";
  const parsed = parseWorkflowScript(script);
  expect(parsed.script).toBe(script);
  expect(parsed.meta.name).toBe("audit-routes");
  expect(parsed.body).toBe("\r\n// ü\r\nreturn 1\r\n");
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.meta)).toBe(true);
  expect(Object.isFrozen(parsed.meta.phases)).toBe(true);
  expect(Object.isFrozen(parsed.meta.phases![0])).toBe(true);
  expect(Object.isFrozen(parsed.literalModels)).toBe(true);
  expect(() => (parsed.meta.phases![0] as { title: string }).title = "Changed").toThrow();
  expect(parsed.meta.phases![0]!.title).toBe("Find");
});

test("workflow parser reports missing, non-literal, and invalid meta with lines", () => {
  expect(() => parseWorkflowScript("not valid js !!!")).toThrow(/^Workflow syntax error:/);
  expect(() => parseWorkflowScript("return 1")).toThrow(/meta.*line 1/i);
  expect(() => parseWorkflowScript("const name = 'x';\nexport const meta = { name, description: 'x' }")).toThrow(/literal.*line 2/i);
  expect(() => parseWorkflowScript("export const meta = { name: 'Not Kebab', description: 'x' }")).toThrow(/kebab-case.*line 1/i);
});

test("workflow parser rejects dynamic import at launch", () => {
  expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'x' };\nawait import('x')")).toThrow(/Dynamic import.*line 2/);
});

test("workflow parser collects string-literal models only from direct agent option objects", () => {
  const script = `export const meta = { name: 'm', description: 'd' };
const inventory = [{ make: 'Toyota', model: 'Corolla' }];
const base = { thinkingLevel: 'high' };
const a = await agent('x', { model: 'openai-codex/gpt-5.6-terra' });
const rows = await parallel(list.map((item) => () => agent('y ' + item, {
  ...base,
  "model": "anthropic/claude-5-sonnet",
  schema: { type: 'object', properties: { model: { type: 'string' } } },
})));
const dynamic = await agent('z', { model: pickModel() });
return rows;`;
  expect(parseWorkflowScript(script).literalModels).toEqual(["openai-codex/gpt-5.6-terra", "anthropic/claude-5-sonnet"]);
});

test("workflow parser ignores model literals in data and indirect agent options", () => {
  const script = `export const meta = { name: 'inventory', description: 'test' };
const inventory = [{ make: 'Toyota', model: 'Corolla' }];
const opts = { model: 'unknown/model' };
return parallel(inventory.map((item) => () => agent('Research ' + item.model, opts)));`;
  expect(parseWorkflowScript(script).literalModels).toEqual([]);
});

test("workflow parser collects spread-adjacent and nested agent model literals", () => {
  const script = `export const meta = { name: 'nested', description: 'test' };
const base = {};
return pipeline([
  () => agent('one', { ...base, model: 'a/b' }),
  () => parallel([() => agent('two', { model: 'c/d' })]),
]);`;
  expect(parseWorkflowScript(script).literalModels).toEqual(["a/b", "c/d"]);
});
