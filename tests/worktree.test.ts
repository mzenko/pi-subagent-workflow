import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_INLINE_WORKTREE_PATCH_BYTES } from "../src/runner/inline-patch.js";
import { cleanupWorktree, collectWorktree, createWorktree } from "../src/runner/worktree.js";

test("worktree collects tracked and untracked changes then cleans up", async () => {
  const repo = mkdtempSync(join(tmpdir(), "subagent-worktree-repo-"));
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "tracked.txt"), "before\n");
  execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
  const path = join(repo, ".runs", "worktrees", "child-1");
  const tree = await createWorktree(repo, path);
  writeFileSync(join(path, "tracked.txt"), "after\n");
  writeFileSync(join(path, "new.txt"), "new\n");
  const changes = await collectWorktree(tree);
  expect(changes.changed.sort()).toEqual(["new.txt", "tracked.txt"]);
  expect(changes.patch).toContain("-before");
  expect(changes.patch).toContain("+after");
  expect(changes.patch).toContain("+new");
  await cleanupWorktree(repo, path);
  expect(existsSync(path)).toBe(false);
});

test("oversized worktree patches fail closed and retain the worktree", async () => {
  const repo = mkdtempSync(join(tmpdir(), "subagent-worktree-oversized-"));
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "base.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
  const path = join(repo, ".runs", "worktrees", "child-large");
  const tree = await createWorktree(repo, path);
  writeFileSync(join(path, "large.txt"), "x".repeat(MAX_INLINE_WORKTREE_PATCH_BYTES + 1024));

  await expect(collectWorktree(tree)).rejects.toMatchObject({
    name: "WorktreeCollectionError",
    worktreePath: tree.path,
    message: expect.stringContaining("inline safety limit"),
  });
  expect(existsSync(path)).toBe(true);
  await cleanupWorktree(repo, path);
});

test("worktree captures work the child committed", async () => {
  const repo = mkdtempSync(join(tmpdir(), "subagent-worktree-commit-"));
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "tracked.txt"), "before\n");
  execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
  const path = join(repo, ".runs", "worktrees", "child-commit");
  const tree = await createWorktree(repo, path);
  // The child stages and commits, advancing the worktree's detached HEAD.
  writeFileSync(join(path, "fix.txt"), "fixed\n");
  execFileSync("git", ["-C", path, "add", "-A"]);
  execFileSync("git", ["-C", path, "commit", "-m", "fix"]);
  const changes = await collectWorktree(tree);
  expect(changes.changed).toContain("fix.txt");
  expect(changes.patch).toContain("+fixed");
  await cleanupWorktree(repo, path);
});

test("worktree creation fails closed outside a git repository", async () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-not-git-"));
  await expect(createWorktree(directory, join(directory, "worktree"))).rejects.toThrow("Failed to create isolated git worktree");
});

test("git subprocesses receive an abort timeout", async () => {
  const repo = mkdtempSync(join(tmpdir(), "subagent-worktree-timeout-"));
  execFileSync("git", ["init", repo]);
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
  try {
    await expect(createWorktree(repo, join(repo, ".runs", "timed-out"))).rejects.toThrow("Failed to create isolated git worktree");
  } finally {
    timeout.mockRestore();
  }
});

test("worktree preserves a nested repo-relative cwd", async () => {
  const repo = mkdtempSync(join(tmpdir(), "subagent-worktree-nested-"));
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  const nested = join(repo, "packages", "api");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "index.ts"), "export {}\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);

  const tree = await createWorktree(nested, join(repo, ".runs", "worktrees", "nested"));
  expect(tree.cwd).toBe(join(tree.path, "packages", "api"));
  expect(existsSync(join(tree.cwd, "index.ts"))).toBe(true);
  await cleanupWorktree(nested, tree.path);
});

test("collection failure is a WorktreeCollectionError naming the retained path", async () => {
  const repo = mkdtempSync(join(tmpdir(), "subagent-worktree-collect-fail-"));
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "f.txt"), "x\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "init"]);
  const path = join(repo, ".runs", "worktrees", "child-x");
  const tree = await createWorktree(repo, path);
  // A base commit that does not exist makes `git diff <base>` fail; the error
  // must carry the worktree path so the runner knows to keep it.
  const broken = { ...tree, baseCommit: "0000000000000000000000000000000000000000" };
  await expect(collectWorktree(broken)).rejects.toMatchObject({ name: "WorktreeCollectionError", worktreePath: tree.path });
  await cleanupWorktree(repo, path);
});
