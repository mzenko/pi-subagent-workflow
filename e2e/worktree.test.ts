import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPi } from "./helpers.js";

test.skipIf(!process.env.RUN_E2E)("worktree child returns a patch and leaves the checkout clean", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-subagent-wt-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
  git("init", "-q");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  const output = await runPi(
    'Call subagent with wait true, isolation "worktree", and prompt "create a file named note.txt containing exactly: from-child".',
    repo,
  );
  const unescaped = output.replace(/\\+/g, "");
  expect(unescaped).toContain("note.txt");
  expect(unescaped).toContain("from-child");
  // The shared checkout must stay untouched - the change exists only in the patch.
  expect(execFileSync("git", ["-C", repo, "status", "--porcelain"]).toString().trim()).toBe("");
});
