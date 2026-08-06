import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
    // hasUI true: these tests exercise the interactive-host background path.
    // Headless (hasUI false) hosts wait inline instead - covered separately.
    ctx: {
      cwd,
      hasUI: true,
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

afterEach(() => releasePendingDeliveries("parent"));

test("a workflow launch returns a running receipt and queues acknowledged delivery", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-tool-background-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  const h = harness(cwd);

  try {
    const output = await h.tool.execute(
      "call",
      { script: "export const meta = { name: 'background-success', description: 'test' };\nreturn { ok: true };" },
      undefined,
      undefined,
      h.ctx as never,
    );
    const text = output.content[0]?.type === "text" ? output.content[0].text : "";
    const started = JSON.parse(text) as { runId: string; runDir: string; status: string };
    const deliveredPath = join(started.runDir, "delivered.json");

    expect(started.status).toBe("running");
    expect(output.details).toMatchObject({ status: "running", runId: started.runId, runDir: started.runDir });

    await waitFor(() => h.delivered.length === 1);
    expect(h.delivered[0]).toContain(`Workflow run ${started.runId}`);
    expect(h.delivered[0]).toContain('"ok":true');
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

test("a turn abort after launch does not stop the background workflow", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-tool-abort-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  const h = harness(cwd);
  const controller = new AbortController();

  try {
    const output = await h.tool.execute(
      "call",
      { script: "export const meta = { name: 'abort-ignored', description: 'test' };\nawait Promise.resolve();\nreturn 'done';" },
      controller.signal,
      undefined,
      h.ctx as never,
    );
    controller.abort();
    const text = output.content[0]?.type === "text" ? output.content[0].text : "";
    const started = JSON.parse(text) as { runId: string };

    await waitFor(() => h.delivered.length === 1);
    expect(h.delivered[0]).toContain(`Workflow run ${started.runId}`);
    expect(h.delivered[0]).toContain("done");
    expect(h.delivered[0]).not.toContain("Workflow stopped");
  } finally {
    restoreAgentDir();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a workflow script failure delivers the failure envelope in the background", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-tool-failure-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  let runId: string | undefined;
  const h = harness(cwd, (run) => { runId = run.runId; });

  try {
    const output = await h.tool.execute(
      "call",
      { script: "export const meta = { name: 'background-failure', description: 'test' };\nthrow new Error('boom');" },
      undefined,
      undefined,
      h.ctx as never,
    );
    const text = output.content[0]?.type === "text" ? output.content[0].text : "";
    expect(JSON.parse(text)).toMatchObject({ status: "running" });

    await waitFor(() => h.delivered.length === 1);
    expect(runId).toBeString();
    expect(h.delivered[0]).toContain("Status: failed");
    expect(h.delivered[0]).toContain("boom");
  } finally {
    restoreAgentDir();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a headless host waits inline and returns the workflow envelope directly", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-tool-headless-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  const h = harness(cwd);

  try {
    const output = await h.tool.execute(
      "call",
      { script: "export const meta = { name: 'headless-success', description: 'test' };\nreturn { ok: true };" },
      undefined,
      undefined,
      { ...h.ctx, hasUI: false } as never,
    );
    const text = output.content[0]?.type === "text" ? output.content[0].text : "";

    // The full delivery envelope comes back in the tool result, the marker is
    // written (fencing catch-up redelivery), and nothing is queued to steer.
    expect(text).toContain("Workflow run ");
    expect(text).toContain('"ok":true');
    const runDir = text.match(/Run directory: (\S+)/)?.[1];
    expect(runDir).toBeDefined();
    expect(JSON.parse(readFileSync(join(runDir!, "delivered.json"), "utf8"))).toMatchObject({ sessionId: "parent" });
    expect(h.delivered).toEqual([]);
  } finally {
    restoreAgentDir();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a headless workflow failure throws the failure envelope inline", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-tool-headless-failure-"));
  const restoreAgentDir = useAgentDir(join(cwd, "agent"));
  let runDir: string | undefined;
  const h = harness(cwd, (run) => { runDir = run.runDir; });

  try {
    await expect(h.tool.execute(
      "call",
      { script: "export const meta = { name: 'headless-failure', description: 'test' };\nthrow new Error('boom');" },
      undefined,
      undefined,
      { ...h.ctx, hasUI: false } as never,
    )).rejects.toThrow(/Status: failed[\s\S]*boom/);

    expect(runDir).toBeString();
    expect(JSON.parse(readFileSync(join(runDir!, "delivered.json"), "utf8"))).toMatchObject({ sessionId: "parent" });
    expect(h.delivered).toEqual([]);
  } finally {
    restoreAgentDir();
    rmSync(cwd, { recursive: true, force: true });
  }
});
