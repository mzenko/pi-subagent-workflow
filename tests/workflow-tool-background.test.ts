import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { subagentRunner } from "../src/runner/runner.js";
import { acknowledgeDeliveryMessage, releasePendingDeliveries } from "../src/store/delivery-marker.js";
import { registerWorkflowTool } from "../src/workflow/workflow-tool.js";

interface Harness {
  tool: ToolDefinition<any, any, any>;
  delivered: string[];
  ctx: Record<string, unknown>;
}

function useAgentDir(path: string): () => void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path;
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  };
}

function harness(cwd: string, observeRun?: (run: { runId: string; runDir: string }) => void): Harness {
  let registered: ToolDefinition<any, any, any> | undefined;
  const delivered: string[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition<any, any, any>) => { registered = tool; },
    getThinkingLevel: () => "off",
    appendEntry: () => undefined,
    sendUserMessage: (message: string) => { delivered.push(message); },
  } as unknown as ExtensionAPI;
  registerWorkflowTool(pi, "/extension.ts", {
    consent: {} as never,
    approve: async () => {},
    approvalPolicy: () => "auto",
    observeRun,
    resolveSaved: () => undefined,
  });
  return {
    tool: registered!,
    delivered,
    ctx: {
      cwd,
      hasUI: false,
      model: { provider: "test", id: "parent-model" },
      modelRegistry: { find: () => undefined, getAll: () => [] },
      sessionManager: { getSessionId: () => "parent", getSessionFile: () => join(cwd, "parent.jsonl") },
    },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for workflow delivery");
}

afterEach(() => {
  subagentRunner.detachWaitedRuns("parent");
  releasePendingDeliveries("parent");
});

test("detaching a waited workflow queues acknowledged background delivery", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-tool-background-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  const h = harness(cwd);
  const detached: string[] = [];

  try {
    const output = await h.tool.execute(
      "call",
      {
        script: "export const meta = { name: 'detach-success', description: 'test' };\nlog('detach-now');\nreturn { ok: true };",
        wait: true,
      },
      undefined,
      (update) => {
        const text = update.content[0]?.type === "text" ? update.content[0].text : "";
        if (text !== "detach-now") return;
        const runId = subagentRunner.waitedRunIds("parent")[0];
        if (runId && subagentRunner.detachWaitedRun(runId, "parent")) detached.push(runId);
      },
      h.ctx as never,
    );
    const text = output.content[0]?.type === "text" ? output.content[0].text : "";
    const backgrounded = JSON.parse(text) as { type: string; runId: string; runDir: string; status: string };
    const deliveredPath = join(backgrounded.runDir, "delivered.json");

    expect(backgrounded).toMatchObject({ type: "workflow_backgrounded", status: "running" });
    expect(detached).toEqual([backgrounded.runId]);
    expect(subagentRunner.waitedRunIds("parent")).toEqual([]);
    expect(existsSync(deliveredPath)).toBe(false);

    await waitFor(() => h.delivered.length === 1);
    expect(h.delivered[0]).toContain(`Workflow run ${backgrounded.runId}`);
    expect(existsSync(deliveredPath)).toBe(false);
    expect(acknowledgeDeliveryMessage("parent", h.delivered[0]!)).toBe(true);
    expect(JSON.parse(readFileSync(deliveredPath, "utf8"))).toEqual({
      v: 1,
      sessionId: "parent",
      catchUp: false,
      generation: 1,
    });
  } finally {
    restoreAgentDir();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("same-tick turn abort after workflow detach cannot abort the backgrounded run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-tool-detach-abort-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  const h = harness(cwd);
  const controller = new AbortController();

  try {
    const output = await h.tool.execute(
      "call",
      {
        script: "export const meta = { name: 'detach-abort', description: 'test' };\nlog('detach-now');\nawait Promise.resolve();\nreturn 'done';",
        wait: true,
      },
      controller.signal,
      (update) => {
        const text = update.content[0]?.type === "text" ? update.content[0].text : "";
        if (text !== "detach-now") return;
        const waited = subagentRunner.waitedRunIds("parent")[0];
        if (!waited) return;
        expect(subagentRunner.detachWaitedRun(waited, "parent")).toBe(true);
        controller.abort();
      },
      h.ctx as never,
    );
    const text = output.content[0]?.type === "text" ? output.content[0].text : "";
    const backgrounded = JSON.parse(text) as { type: string; runId: string };

    expect(backgrounded.type).toBe("workflow_backgrounded");
    await waitFor(() => h.delivered.length === 1);
    expect(h.delivered[0]).toContain(`Workflow run ${backgrounded.runId}`);
    expect(h.delivered[0]).toContain("done");
    expect(h.delivered[0]).not.toContain("Workflow stopped");
  } finally {
    restoreAgentDir();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("mid-wait turn abort stops a workflow inline", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-tool-wait-abort-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  let runId: string | undefined;
  const h = harness(cwd, (run) => { runId = run.runId; });
  const controller = new AbortController();

  try {
    const execution = h.tool.execute(
      "call",
      {
        script: "export const meta = { name: 'wait-abort', description: 'test' };\nlog('ready');\nawait new Promise(() => {});",
        wait: true,
      },
      controller.signal,
      (update) => {
        const text = update.content[0]?.type === "text" ? update.content[0].text : "";
        if (text === "ready") controller.abort();
      },
      h.ctx as never,
    );

    await expect(execution).rejects.toThrow(/Status: aborted[\s\S]*intentionally stopped/);
    expect(runId).toBeString();
    expect(subagentRunner.waitedRunIds("parent")).toEqual([]);
    expect(h.delivered).toEqual([]);
  } finally {
    restoreAgentDir();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("detach refuses a waited workflow after the turn aborts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-tool-wait-abort-detach-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  let runId: string | undefined;
  let detachResult: boolean | undefined;
  const h = harness(cwd, (run) => { runId = run.runId; });
  const controller = new AbortController();

  try {
    const execution = h.tool.execute(
      "call",
      {
        script: "export const meta = { name: 'wait-abort-detach', description: 'test' };\nlog('ready');\nawait new Promise(() => {});",
        wait: true,
      },
      controller.signal,
      (update) => {
        const text = update.content[0]?.type === "text" ? update.content[0].text : "";
        if (text !== "ready") return;
        controller.abort();
        detachResult = subagentRunner.detachWaitedRun(runId!, "parent");
      },
      h.ctx as never,
    );

    await expect(execution).rejects.toThrow(/Status: aborted[\s\S]*intentionally stopped/);
    expect(runId).toBeString();
    expect(detachResult).toBe(false);
    expect(subagentRunner.waitedRunIds("parent")).toEqual([]);
    expect(h.delivered).toEqual([]);
  } finally {
    restoreAgentDir();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow completion claiming first refuses detach and returns the inline result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-tool-inline-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  let runId: string | undefined;
  let detach: (() => boolean) | undefined;
  const h = harness(cwd, (run) => { runId = run.runId; });
  const registerWaitedRun = subagentRunner.registerWaitedRun.bind(subagentRunner);
  const register = spyOn(subagentRunner, "registerWaitedRun").mockImplementation((...args) => {
    detach = args[2];
    registerWaitedRun(...args);
  });

  try {
    const output = await h.tool.execute(
      "call",
      {
        script: "export const meta = { name: 'inline-success', description: 'test' };\nreturn 'done';",
        wait: true,
      },
      undefined,
      undefined,
      h.ctx as never,
    );
    const text = output.content[0]?.type === "text" ? output.content[0].text : "";
    const completed = JSON.parse(text) as { type: string; runDir: string; status: string; result: unknown };

    expect(runId).toBeString();
    expect(detach).toBeFunction();
    expect(completed).toMatchObject({ type: "workflow_result", status: "completed", result: "done" });
    expect(subagentRunner.waitedRunIds("parent")).toEqual([]);
    expect(subagentRunner.detachWaitedRun(runId!, "parent")).toBe(false);
    expect(detach!()).toBe(false);
    expect(existsSync(join(completed.runDir, "delivered.json"))).toBe(true);
    expect(h.delivered).toEqual([]);
  } finally {
    register.mockRestore();
    restoreAgentDir();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("inline workflow failure cleans up the wait registry without queuing delivery", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-tool-inline-failure-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  let runId: string | undefined;
  let runDir: string | undefined;
  const h = harness(cwd, (run) => {
    runId = run.runId;
    runDir = run.runDir;
  });

  try {
    await expect(h.tool.execute(
      "call",
      {
        script: "export const meta = { name: 'inline-failure', description: 'test' };\nthrow new Error('boom');",
        wait: true,
      },
      undefined,
      undefined,
      h.ctx as never,
    )).rejects.toThrow("boom");

    expect(runId).toBeString();
    expect(runDir).toBeString();
    expect(subagentRunner.waitedRunIds("parent")).toEqual([]);
    expect(h.delivered).toEqual([]);
    expect(JSON.parse(readFileSync(join(runDir!, "delivered.json"), "utf8"))).toEqual({
      v: 1,
      sessionId: "parent",
      catchUp: false,
      generation: 1,
    });
  } finally {
    restoreAgentDir();
    rmSync(cwd, { recursive: true, force: true });
  }
});
