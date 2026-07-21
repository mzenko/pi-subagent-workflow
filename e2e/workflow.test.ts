import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runPi } from "./helpers.js";

test.skipIf(!process.env.RUN_E2E)("two-phase workflow persists phases and journal", async () => {
  const script = `export const meta = { name: 'color-audit', description: 'Discover and audit colors', phases: [{ title: 'Discover' }, { title: 'Audit' }] };
const found = await agent('Return exactly two color names', { schema: { type: 'object', properties: { colors: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 } }, required: ['colors'], additionalProperties: false } });
phase('Audit');
return parallel(found.colors.map(color => () => agent('Describe the color ' + color)));`;
  const output = await runPi(`Call workflow with wait true using this exact script: ${JSON.stringify(script)}`);
  const runDir = output.match(/"runDir"\s*:\s*"([^"]+)"/)?.[1]?.replaceAll("\\/", "/");
  expect(runDir).toBeDefined();
  const run = JSON.parse(await readFile(join(runDir!, "run.json"), "utf8"));
  expect(run.phases.map((phase: { title: string }) => phase.title)).toEqual(["Discover", "Audit"]);
  // phase rides inside the persisted spec (the duplicated child.phase field was removed)
  expect(run.children[0].spec.phase).toBe("Discover");
  expect(run.children.slice(1).every((child: { spec: { phase?: string } }) => child.spec.phase === "Audit")).toBe(true);
  const journal = (await readFile(join(runDir!, "journal.jsonl"), "utf8")).trim().split("\n");
  expect(journal).toHaveLength(3);
});

// Parameterized workflows are a core usage: `args` reaches the VM and the return
// value is persisted to result.json. This script has no child agents, so a green
// run isolates the args -> VM -> result path from any model behavior. Asserting on
// the derived sum (19 + 23) rules out a false pass from the inputs echoed in the
// transcript.
test.skipIf(!process.env.RUN_E2E)("workflow reads args and persists a derived return value", async () => {
  const script = `export const meta = { name: 'sum-args', description: 'Sum two numbers from args', phases: [] };
return { total: args.a + args.b };`;
  const output = await runPi(`Call workflow with wait true, args {"a":19,"b":23}, and this exact script: ${JSON.stringify(script)}`);
  const runDir = output.match(/"runDir"\s*:\s*"([^"]+)"/)?.[1]?.replaceAll("\\/", "/");
  expect(runDir).toBeDefined();
  const result = JSON.parse(await readFile(join(runDir!, "result.json"), "utf8"));
  expect(result).toEqual({ total: 42 });
});

// pipeline() is the documented default primitive: each item flows through every
// stage independently, and every stage is called as stage(item, previous). Stage 1
// derives a value distinguishable from the item (SIERRA-7 from sierra), so the
// assertions can only pass when stage 2 receives the original item first and the
// prior stage's result second - identical values would mask swapped parameters.
test.skipIf(!process.env.RUN_E2E)("pipeline passes (item, previous) to stages and returns per-item final results", async () => {
  const script = `export const meta = { name: 'echo-pipeline', description: 'Two-stage echo pipeline', phases: [] };
return pipeline(['sierra', 'tango'],
  (word) => agent('Reply with exactly this text and nothing else: ' + word.toUpperCase() + '-7'),
  (word, previous) => ({ word, fromPrevious: String(previous).trim() }));`;
  const output = await runPi(`Call workflow with wait true using this exact script: ${JSON.stringify(script)}`);
  const runDir = output.match(/"runDir"\s*:\s*"([^"]+)"/)?.[1]?.replaceAll("\\/", "/");
  expect(runDir).toBeDefined();
  const result = JSON.parse(await readFile(join(runDir!, "result.json"), "utf8")) as Array<{ word: string; fromPrevious: string }>;
  // First parameter carried the untransformed items, in item order.
  expect(result.map((row) => row.word)).toEqual(["sierra", "tango"]);
  // Second parameter carried stage 1's derived output, which never equals the item.
  expect(result[0]!.fromPrevious).toContain("SIERRA-7");
  expect(result[1]!.fromPrevious).toContain("TANGO-7");
});
