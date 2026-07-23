import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// An npm install places the package under node_modules, where Node's native
// loader refuses to type-strip .ts files. The extension host runs under jiti
// (which transpiles in-process), but the workflow VM worker entry is loaded
// natively by worker_threads - the one place that escapes jiti. Reproduce the
// full condition: pack the real tarball, extract it under node_modules, load
// the host through jiti exactly as pi does, and run a workflow body under
// plain Node. Running this under bun would mask the bug (bun transpiles
// worker entries too), hence the spawned node process.
test("packed tarball runs a workflow when installed under node_modules", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const stage = mkdtempSync(join(tmpdir(), "pi-subagent-npm-install-"));
  try {
    const pack = Bun.spawn(["npm", "pack", "--pack-destination", stage], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    const [packExit, packErr] = await Promise.all([pack.exited, new Response(pack.stderr).text()]);
    if (packExit !== 0) throw new Error(`npm pack failed:\n${packErr}`);
    const tarball = readdirSync(stage).find((name) => name.endsWith(".tgz"));
    if (!tarball) throw new Error("npm pack produced no tarball");

    const untar = Bun.spawn(["tar", "xzf", join(stage, tarball), "-C", stage], { stderr: "pipe" });
    if ((await untar.exited) !== 0) throw new Error(await new Response(untar.stderr).text());
    mkdirSync(join(stage, "node_modules"));
    renameSync(join(stage, "package"), join(stage, "node_modules", "pi-subagent-workflow"));

    const jitiUrl = import.meta.resolve("jiti");
    const vmUrl = pathToFileURL(join(stage, "node_modules", "pi-subagent-workflow", "src", "workflow", "vm.ts")).href;
    const driverPath = join(stage, "driver.mjs");
    await Bun.write(driverPath, `
      import * as jitiModule from ${JSON.stringify(jitiUrl)};
      const createJiti = jitiModule.createJiti ?? jitiModule.default.createJiti;
      const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
      const { executeWorkflowBody } = await jiti.import(${JSON.stringify(vmUrl)});
      const api = { agent: async (prompt) => "echo:" + prompt, phase: () => {}, log: () => {}, args: null };
      const result = await executeWorkflowBody("return await agent('ping')", "npm-install-entry", api);
      if (result !== "echo:ping") throw new Error("unexpected result: " + JSON.stringify(result));
    `);
    const probe = Bun.spawn(["node", driverPath], { cwd: stage, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([probe.exited, new Response(probe.stderr).text()]);
    expect(stderr).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
    if (exitCode !== 0) throw new Error(`workflow under node_modules failed (code ${exitCode}):\n${stderr}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}, 120_000);
