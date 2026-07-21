import { expect, test } from "bun:test";
import { runPi } from "./helpers.js";
test.skipIf(!process.env.RUN_E2E)("fresh structured child", async () => {
  const output = await runPi('Call subagent with wait true, prompt "return answer 7", and schema requiring integer property answer.');
  // The tool result is nested JSON inside JSONL, so unescape before matching.
  expect(output.replace(/\\+/g, "")).toContain('"structured":{"answer":7}');
});
