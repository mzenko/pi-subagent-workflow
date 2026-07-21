import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The settings store is a process-wide singleton built on first access from
// the default agent dir, so the first test to construct the extension would
// read - and, since v2-to-v3 migration, rewrite - the developer's real
// ~/.pi settings file. Point every test process at a throwaway agent dir
// before any test module loads. An explicit override is respected so a
// deliberately-configured dir still wins.
process.env.PI_CODING_AGENT_DIR ??= mkdtempSync(join(tmpdir(), "pi-subagent-tests-"));

// The e2e helper seeds a temp agent dir with a copy of the user's real
// credentials and publishes its path here. bun test never fires process
// exit handlers, so this run-global afterAll (preload hooks apply to the
// whole run) is the only reliable teardown for it.
afterAll(() => {
  const dir = (globalThis as Record<string, unknown>).__piSubagentE2eAgentDir;
  if (typeof dir === "string") rmSync(dir, { recursive: true, force: true });
});
