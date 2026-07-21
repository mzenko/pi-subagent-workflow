import { expect, test } from "bun:test";
import { runPi } from "./helpers.js";
test.skipIf(!process.env.RUN_E2E)("fan-out two", async () => {
  const output = await runPi("Call subagent with wait true and two specs. Ask one to reply ALPHA and one BETA.");
  expect(output).toContain("ALPHA"); expect(output).toContain("BETA");
});

test.skipIf(!process.env.RUN_E2E)("fan-out preserves a successful sibling when one child cannot start", async () => {
  const output = await runPi(`Call subagent exactly once with wait true and exactly two specs in this order.
The first spec should ask the child to reply with exactly ALPHA.
The second spec should ask the child to reply BETA and must set model to missing-provider/definitely-missing-model.
Do not retry or replace the invalid model.`);
  expect(output).toContain("ALPHA");
  expect(output).toMatch(/status[^\n]*failed/i);
});
