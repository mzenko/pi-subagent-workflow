import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  catchUpUndeliveredRuns,
  formatCatchUpMessage,
} from "../extensions/subagent-workflow.js";
import {
  acknowledgeDeliveryMessage,
  DELIVERY_PROTOCOL_VERSION,
  markSessionClosed,
  markSessionOpen,
  queueAcknowledgedDelivery,
  readDeliveryMarker,
  releasePendingDeliveries,
  writeDeliveryMarker,
} from "../src/store/delivery-marker.js";
import { acquireRunOwnership } from "../src/store/lease.js";
import { encodeCwd, RunStore } from "../src/store/run-store.js";

const CWD = "/work/catch-up";
const SESSION_ID = "session-current";

afterEach(() => {
  releasePendingDeliveries(SESSION_ID);
  markSessionOpen(SESSION_ID);
});

test("startup catch-up publishes only after the matching user message_start", () => {
  const root = mkdtempSync(join(tmpdir(), "catch-up-ack-"));
  const runsRoot = join(root, "runs");
  const selected = runFixture(runsRoot, CWD, "run-selected", { sessionId: SESSION_ID, label: "Selected work" });
  const messages: string[] = [];
  const pi = { sendUserMessage: (message: string) => { messages.push(message); } } as unknown as ExtensionAPI;
  try {
    expect(catchUpUndeliveredRuns(pi, context(), runsRoot).map((run) => run.runId)).toEqual(["run-selected"]);
    expect(messages).toEqual([
      `Recovered background run deliveries:\n- run-selected | Selected work | completed | ${selected}`,
    ]);
    expect(existsSync(join(selected, "delivered.json"))).toBe(false);

    expect(acknowledgeDeliveryMessage(SESSION_ID, "an unrelated user prompt")).toBe(false);
    expect(existsSync(join(selected, "delivered.json"))).toBe(false);

    expect(acknowledgeDeliveryMessage(SESSION_ID, `prefixed context\n${messages[0]!}\nappended context`)).toBe(true);
    expect(readDeliveryMarker(selected)).toEqual({
      v: 1,
      sessionId: SESSION_ID,
      catchUp: true,
      generation: 1,
    });
    const ownership = acquireRunOwnership(selected);
    ownership.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume during pending catch-up supersedes the stale delivery", () => {
  const root = mkdtempSync(join(tmpdir(), "catch-up-resume-"));
  const runsRoot = join(root, "runs");
  const script = "export const meta = { name: 'resume', description: 'test' };\nreturn 1;\n";
  const first = new RunStore("workflow-resumed", CWD, SESSION_ID, undefined, { rootDir: runsRoot, kind: "workflow" });
  first.startWorkflowGeneration(script, undefined);
  first.workflowFinished("completed");
  const messages: string[] = [];
  const pi = { sendUserMessage: (message: string) => { messages.push(message); } } as unknown as ExtensionAPI;
  try {
    expect(catchUpUndeliveredRuns(pi, context(), runsRoot).map((run) => run.generation)).toEqual([1]);
    expect(existsSync(join(first.runDir, "delivered.json"))).toBe(false);

    const resumed = new RunStore("workflow-resumed", CWD, SESSION_ID, undefined, { existingRunDir: first.runDir });
    resumed.startWorkflowGeneration(script, undefined, {}, { requireExistingScript: true });
    expect(resumed.deliveryIdentity?.generation).toBe(2);
    resumed.workflowFinished("completed");

    expect(acknowledgeDeliveryMessage(SESSION_ID, messages[0]!)).toBe(true);
    expect(readDeliveryMarker(first.runDir)).toBeUndefined();
    expect(catchUpUndeliveredRuns(pi, context(), runsRoot).map((run) => run.generation)).toEqual([2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acknowledgement during a temporary ownership conflict defers instead of dropping", () => {
  const root = mkdtempSync(join(tmpdir(), "catch-up-conflict-"));
  const runsRoot = join(root, "runs");
  const script = "export const meta = { name: 'resume', description: 'test' };\nreturn 1;\n";
  const first = new RunStore("workflow-conflict", CWD, SESSION_ID, undefined, { rootDir: runsRoot, kind: "workflow" });
  first.startWorkflowGeneration(script, undefined);
  first.workflowFinished("completed");
  const messages: string[] = [];
  const pi = { sendUserMessage: (message: string) => { messages.push(message); } } as unknown as ExtensionAPI;
  try {
    expect(catchUpUndeliveredRuns(pi, context(), runsRoot).map((run) => run.generation)).toEqual([1]);

    // A resume in another process owns the run but has not advanced the
    // generation yet (setup phase). Acknowledgement lands in that window.
    const resuming = acquireRunOwnership(first.runDir);
    expect(acknowledgeDeliveryMessage(SESSION_ID, messages[0]!)).toBe(true);
    expect(readDeliveryMarker(first.runDir)).toBeUndefined();

    // The resume fails during setup and releases ownership unchanged. The
    // next startup settles the deferred publication before scanning, so
    // catch-up cannot redeliver the already-consumed message.
    resuming.release();
    expect(catchUpUndeliveredRuns(pi, context(), runsRoot)).toEqual([]);
    expect(readDeliveryMarker(first.runDir)?.generation).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a synchronous startup send failure releases its ownership claim", () => {
  const root = mkdtempSync(join(tmpdir(), "catch-up-send-failure-"));
  const runsRoot = join(root, "runs");
  const runDir = runFixture(runsRoot, CWD, "run-retry", { sessionId: SESSION_ID });
  const throwing = { sendUserMessage: () => { throw new Error("session unavailable"); } } as unknown as ExtensionAPI;
  try {
    expect(() => catchUpUndeliveredRuns(throwing, context(), runsRoot)).toThrow("session unavailable");
    expect(existsSync(join(runDir, "delivered.json"))).toBe(false);
    const ownership = acquireRunOwnership(runDir);
    ownership.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unacknowledged preflight leaves ownership free and catch-up immediately retryable", () => {
  const root = mkdtempSync(join(tmpdir(), "catch-up-preflight-"));
  const runsRoot = join(root, "runs");
  const runDir = runFixture(runsRoot, CWD, "run-preflight", { sessionId: SESSION_ID });
  const pi = { sendUserMessage: () => {} } as unknown as ExtensionAPI;
  try {
    expect(catchUpUndeliveredRuns(pi, context(), runsRoot).map((run) => run.runId)).toEqual(["run-preflight"]);
    expect(existsSync(join(runDir, "delivered.json"))).toBe(false);
    const ownership = acquireRunOwnership(runDir);
    ownership.release();

    const messages: string[] = [];
    const retry = { sendUserMessage: (message: string) => { messages.push(message); } } as unknown as ExtensionAPI;
    expect(catchUpUndeliveredRuns(retry, context(), runsRoot).map((run) => run.runId)).toEqual(["run-preflight"]);
    expect(messages).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale acknowledgement cannot overwrite a newer generation marker", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-stale-generation-"));
  const runsRoot = join(root, "runs");
  const script = "export const meta = { name: 'resume', description: 'test' };\nreturn 1;\n";
  const first = new RunStore("workflow-stale", CWD, SESSION_ID, undefined, { rootDir: runsRoot, kind: "workflow" });
  first.startWorkflowGeneration(script, undefined);
  const firstIdentity = first.deliveryIdentity!;
  first.workflowFinished("completed");
  const message = "Workflow run workflow-stale generation 1";
  const pi = { sendUserMessage: () => {} } as unknown as ExtensionAPI;
  try {
    queueAcknowledgedDelivery(pi, {
      sessionId: SESSION_ID,
      message,
      targets: [{ runDir: first.runDir, identity: firstIdentity }],
    });

    const resumed = new RunStore("workflow-stale", CWD, SESSION_ID, undefined, { existingRunDir: first.runDir });
    resumed.startWorkflowGeneration(script, undefined, {}, { requireExistingScript: true });
    const secondIdentity = resumed.deliveryIdentity!;
    resumed.workflowFinished("completed");
    expect(secondIdentity.generation).toBe(2);
    expect(writeDeliveryMarker(first.runDir, SESSION_ID, secondIdentity)).toBe(true);

    expect(acknowledgeDeliveryMessage(SESSION_ID, message)).toBe(true);
    expect(readDeliveryMarker(first.runDir)?.generation).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closed sessions reject late deliveries until reopened", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-closed-session-"));
  const runsRoot = join(root, "runs");
  const runDir = runFixture(runsRoot, CWD, "run-closed", { sessionId: SESSION_ID });
  const message = "Subagent run run-closed";
  const messages: string[] = [];
  const pi = { sendUserMessage: (text: string) => { messages.push(text); } } as unknown as ExtensionAPI;
  try {
    markSessionClosed(SESSION_ID);
    queueAcknowledgedDelivery(pi, {
      sessionId: SESSION_ID,
      message,
      targets: [{ runDir, identity: { protocol: DELIVERY_PROTOCOL_VERSION, generation: 1 } }],
    });
    expect(messages).toEqual([]);
    expect(acknowledgeDeliveryMessage(SESSION_ID, message)).toBe(false);
    expect(readDeliveryMarker(runDir)).toBeUndefined();

    markSessionOpen(SESSION_ID);
    queueAcknowledgedDelivery(pi, {
      sessionId: SESSION_ID,
      message,
      targets: [{ runDir, identity: { protocol: DELIVERY_PROTOCOL_VERSION, generation: 1 } }],
    });
    expect(messages).toEqual([message]);
    expect(acknowledgeDeliveryMessage(SESSION_ID, message)).toBe(true);
    expect(readDeliveryMarker(runDir)?.generation).toBe(1);
  } finally {
    markSessionOpen(SESSION_ID);
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivery acknowledgement reads only run.json identity", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-identity-read-"));
  const runsRoot = join(root, "runs");
  const runDir = runFixture(runsRoot, CWD, "run-poison-events", { sessionId: SESSION_ID });
  const message = "Subagent run run-poison-events";
  writeFileSync(join(runDir, "events.jsonl"), "{not valid json}\n");
  const pi = { sendUserMessage: () => {} } as unknown as ExtensionAPI;
  try {
    queueAcknowledgedDelivery(pi, {
      sessionId: SESSION_ID,
      message,
      targets: [{ runDir, identity: { protocol: DELIVERY_PROTOCOL_VERSION, generation: 1 } }],
    });
    expect(acknowledgeDeliveryMessage(SESSION_ID, message)).toBe(true);
    expect(readDeliveryMarker(runDir)).toEqual({
      v: 1,
      sessionId: SESSION_ID,
      catchUp: false,
      generation: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a marker for an earlier generation does not suppress catch-up", () => {
  const root = mkdtempSync(join(tmpdir(), "catch-up-old-marker-"));
  const runsRoot = join(root, "runs");
  const runDir = runFixture(runsRoot, CWD, "run-generation-2", { sessionId: SESSION_ID, generation: 2 });
  writeFileSync(join(runDir, "delivered.json"), `${JSON.stringify({
    v: 1,
    sessionId: SESSION_ID,
    catchUp: false,
    generation: 1,
  })}\n`);
  const pi = { sendUserMessage: () => {} } as unknown as ExtensionAPI;
  try {
    expect(catchUpUndeliveredRuns(pi, context(), runsRoot).map((run) => run.runId)).toEqual(["run-generation-2"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy v2 terminal records are skipped instead of redelivered", () => {
  const root = mkdtempSync(join(tmpdir(), "catch-up-legacy-"));
  const runsRoot = join(root, "runs");
  const runDir = runFixture(runsRoot, CWD, "run-legacy", { sessionId: SESSION_ID, legacy: true });
  const messages: string[] = [];
  const pi = { sendUserMessage: (message: string) => { messages.push(message); } } as unknown as ExtensionAPI;
  try {
    expect(catchUpUndeliveredRuns(pi, context(), runsRoot)).toEqual([]);
    expect(messages).toEqual([]);
    expect(existsSync(join(runDir, "delivered.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live-owned and quarantined runs remain ineligible", () => {
  const root = mkdtempSync(join(tmpdir(), "catch-up-ineligible-"));
  const runsRoot = join(root, "runs");
  const liveOwned = runFixture(runsRoot, CWD, "run-live", { sessionId: SESSION_ID });
  runFixture(runsRoot, CWD, "run-quarantined", { sessionId: SESSION_ID, quarantined: true });
  const ownership = acquireRunOwnership(liveOwned);
  const pi = { sendUserMessage: () => {} } as unknown as ExtensionAPI;
  try {
    expect(catchUpUndeliveredRuns(pi, context(), runsRoot)).toEqual([]);
  } finally {
    ownership.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("catch-up message formatting is compact and stable", () => {
  expect(formatCatchUpMessage([{
    runId: "run-1",
    runDir: "/runs/run-1",
    label: "Audit routes",
    status: "failed",
    createdAt: 1,
    generation: 3,
  }])).toBe("Recovered background run deliveries:\n- run-1 | Audit routes | failed | /runs/run-1");
});

function context(): ExtensionContext {
  return {
    cwd: CWD,
    sessionManager: { getSessionId: () => SESSION_ID },
  } as unknown as ExtensionContext;
}

function runFixture(
  runsRoot: string,
  cwd: string,
  runId: string,
  options: {
    sessionId: string;
    label?: string;
    status?: "completed" | "failed" | "aborted";
    generation?: number;
    legacy?: boolean;
    quarantined?: boolean;
  },
): string {
  const runDir = join(runsRoot, encodeCwd(cwd), runId);
  const status = options.status ?? "completed";
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    v: options.legacy ? 2 : 3,
    runId,
    kind: "subagent",
    createdAt: "2026-01-01T00:00:00.000Z",
    parent: { sessionId: options.sessionId },
    children: [{
      id: "child-1",
      spec: { prompt: `Work ${runId}` },
      resolved: { label: options.label ?? `Work ${runId}` },
    }],
    ...(options.legacy ? {} : {
      delivery: { protocol: DELIVERY_PROTOCOL_VERSION, generation: options.generation ?? 1 },
    }),
  })}\n`);
  writeFileSync(join(runDir, "status.json"), `${JSON.stringify({
    status,
    children: {
      "child-1": {
        status,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      },
    },
  })}\n`);
  writeFileSync(join(runDir, "events.jsonl"), "");
  if (options.quarantined) writeFileSync(join(runDir, "generation.pending"), "{}\n");
  return runDir;
}
