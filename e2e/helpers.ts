import { spawn } from "bun";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// Spawned pi processes get a throwaway agent dir seeded with the user's real
// credentials: hermetic settings/sessions (the extension now rewrites v2
// settings files on load, which tests must never do to the real file) while
// provider auth keeps working. Seed from the default ~/.pi/agent location:
// the unit-test preload already points PI_CODING_AGENT_DIR at a temp dir.
export const agentDir = (() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-e2e-agent-"));
  for (const file of ["auth.json", "trust.json"]) {
    const source = join(homedir(), ".pi", "agent", file);
    if (existsSync(source)) copyFileSync(source, join(dir, file));
  }
  // The dir holds a credential copy; never leave it behind in /tmp. bun test
  // does not fire process exit handlers, so the shared test preload removes
  // whatever dir is published here in a run-global afterAll.
  (globalThis as Record<string, unknown>).__piSubagentE2eAgentDir = dir;
  return dir;
})();

export async function runPi(prompt: string, cwd?: string): Promise<string> {
  // -ne disables extension discovery so the suite is hermetic: it loads only the
  // extension under test (via -e) regardless of what is installed in the user's
  // environment. Without it, a globally-installed copy double-loads and trips the
  // recursion guard - which is the normal state on a machine that develops this.
  const process = spawn(["pi", "--mode", "json", "-p", "-ne", "--model", "openai-codex/gpt-5.6-luna", "-e", new URL("../extensions/subagent-workflow.ts", import.meta.url).pathname, prompt],
    { cwd: cwd ?? await mkdtemp(join(tmpdir(), "pi-subagent-e2e-")), stdout: "pipe", stderr: "pipe", env: processEnv() });
  const timeout = setTimeout(() => process.kill(), 180_000);
  const output = await new Response(process.stdout).text();
  const error = await new Response(process.stderr).text();
  const code = await process.exited;
  clearTimeout(timeout);
  if (code !== 0) throw new Error(error || output);
  return output;
}

function processEnv(): Record<string, string | undefined> { return { ...globalThis.process.env, PI_CODING_AGENT_DIR: agentDir }; }
