import { expect, test } from "bun:test";
import { agentDir, runPi } from "./helpers.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCwd } from "../src/store/run-store.js";
test.skipIf(!process.env.RUN_E2E)("child one-liner", async () => {
  expect(await runPi("Call subagent with wait true and prompt: Reply only PONG." )).toContain("PONG");
});

test.skipIf(!process.env.RUN_E2E)("spawn persists a run and child session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-e2e-persistence-"));
  await runPi("Call subagent with wait true and prompt: Reply only PONG.", cwd);
  const runsDir = join(agentDir, "subagent-workflow", "runs", encodeCwd(cwd));
  const latest = readdirSync(runsDir).sort().at(-1);
  expect(latest).toBeDefined();
  const sessionsDir = join(runsDir, latest!, "sessions");
  expect(existsSync(sessionsDir)).toBe(true);
  expect(readdirSync(sessionsDir).some((name) => name.endsWith(".jsonl"))).toBe(true);
});

// Narrowing a child's toolset is a core option. Reading the persisted child status
// (rather than the reply text, which the prompt echoes into the transcript) proves
// the narrowed child actually spawned and ran to completion instead of erroring in
// toolset resolution.
test.skipIf(!process.env.RUN_E2E)("child with a narrowed toolset runs to completion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-e2e-tools-"));
  await runPi('Call subagent with wait true, set excludeTools to ["read","write","edit","bash"], and prompt: Reply with exactly the word GRANITE.', cwd);
  const runsDir = join(agentDir, "subagent-workflow", "runs", encodeCwd(cwd));
  const latest = readdirSync(runsDir).sort().at(-1);
  expect(latest).toBeDefined();
  const status = JSON.parse(readFileSync(join(runsDir, latest!, "status.json"), "utf8"));
  const children = Object.values(status.children) as Array<{ status: string }>;
  expect(children).toHaveLength(1);
  expect(children[0]!.status).toBe("completed");
});

// The dogfooding pilot's finding: a child that explicitly requests tools
// which do not resolve must fail closed with a diagnostic, not complete the
// task from model memory. E2e children discover no extensions, so web tools
// reproduce the missing-capability case exactly.
test.skipIf(!process.env.RUN_E2E)("explicitly requested unresolvable tools fail the child", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-e2e-missing-tools-"));
  const output = await runPi('Call subagent with wait true, set tools to ["web_search","fetch_content"], and prompt: Look up the current weather in Malta and reply with it.', cwd);
  const runsDir = join(agentDir, "subagent-workflow", "runs", encodeCwd(cwd));
  const latest = readdirSync(runsDir).sort().at(-1);
  expect(latest).toBeDefined();
  const status = JSON.parse(readFileSync(join(runsDir, latest!, "status.json"), "utf8"));
  const children = Object.values(status.children) as Array<{ status: string }>;
  expect(children).toHaveLength(1);
  expect(children[0]!.status).toBe("failed");
  expect(output).toContain("Missing explicitly requested tools");
});
