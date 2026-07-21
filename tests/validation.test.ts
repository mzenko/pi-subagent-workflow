import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { parseModel, resolveModel } from "../src/runner/child.js";
import { encodeCwd, RunStore } from "../src/store/run-store.js";
import { hasSessionClosedMarker, writeSessionClosedMarker } from "../src/store/session-closed-marker.js";
import { readRunSnapshot } from "../src/store/run-snapshot.js";
import { resolveFollowUpSpec, SubagentToolParameters, validateSubagentInput } from "../src/tool/subagent-tool.js";
import type { ResolvedSpec, SubagentSpec, SubagentStatus } from "../src/types.js";


describe("subagent validation", () => {
  test("requires exactly one of prompt, specs, or followUp", () => {
    expect(() => validateSubagentInput({})).toThrow("Provide exactly one of prompt, specs, or followUp");
    expect(() => validateSubagentInput({ prompt: "one", specs: [{ prompt: "two" }] }))
      .toThrow("Provide exactly one of prompt, specs, or followUp");
    expect(() => validateSubagentInput({ prompt: "one", followUp: { id: "child", prompt: "two" } }))
      .toThrow("Provide exactly one of prompt, specs, or followUp");
    expect(validateSubagentInput({ prompt: "one" })).toEqual({
      type: "spawn",
      specs: [{ prompt: "one", model: undefined, thinkingLevel: undefined, tools: undefined, excludeTools: undefined,
        schema: undefined, cwd: undefined, label: undefined, isolation: undefined }],
    });
    expect(validateSubagentInput({ followUp: { id: "child", prompt: "continue" } })).toEqual({
      type: "followUp", id: "child", prompt: "continue",
    });
  });

  test("accepts a spec with schema and rejects whitespace-only prompts anywhere", () => {
    expect(() => validateSubagentInput({ prompt: "x", schema: { type: "object" } })).not.toThrow();
    expect(() => validateSubagentInput({ prompt: "   " })).toThrow("must not be empty");
    expect(() => validateSubagentInput({ specs: [{ prompt: "ok" }, { prompt: " " }] })).toThrow("must not be empty");
  });

  test("runtime validation rejects invalid values, wrong types, and unknown spec fields", () => {
    expect(() => validateSubagentInput({ prompt: "x", isolation: "work-tree" } as never))
      .toThrow("Invalid subagent input/isolation");
    expect(() => validateSubagentInput({ prompt: "x", tools: "read" } as never))
      .toThrow("Invalid subagent input/tools");
    expect(() => validateSubagentInput({ specs: [{ prompt: "x", surprise: true }] } as never))
      .toThrow("Invalid subagent input/specs/0/surprise");
    expect(() => validateSubagentInput({ followUp: { id: "subagent-1", prompt: "continue", schema: {} } } as never))
      .toThrow("Invalid subagent input/followUp/schema");
  });

  test("schema rejects a direct empty model but leaves fan-out model failures per child", () => {
    expect(Value.Check(SubagentToolParameters, { prompt: "one", model: "" })).toBe(false);
    expect(Value.Check(SubagentToolParameters, {
      specs: [{ prompt: "inherits" }, { prompt: "fails independently", model: "" }],
    })).toBe(true);
  });

  test("rejects per-spec fields set at the top level alongside specs", () => {
    expect(() => validateSubagentInput({ specs: [{ prompt: "a" }], model: "openai-codex/gpt-5.6-luna" }))
      .toThrow("set model inside each specs entry");
    expect(() => validateSubagentInput({ specs: [{ prompt: "a" }], isolation: "worktree" }))
      .toThrow("set isolation inside each specs entry");
    expect(() => validateSubagentInput({ followUp: { id: "child", prompt: "more" }, tools: ["read"] }))
      .toThrow("With followUp, tools is invalid at the top level");
    expect(validateSubagentInput({ specs: [{ prompt: "a", model: "p/m" }] })).toEqual({
      type: "spawn",
      specs: [{ prompt: "a", model: "p/m" }],
    });
  });

});

interface HistoricalChildOptions {
  root: string;
  cwd: string;
  runId: string;
  childId: string;
  createdAt: string;
  spec?: SubagentSpec;
  resolved?: ResolvedSpec;
  status?: SubagentStatus;
  sessionFile?: boolean;
  sessionClosed?: boolean;
  version?: 2 | 3;
}

function historicalChild(options: HistoricalChildOptions): string | undefined {
  const store = new RunStore(options.runId, options.cwd, "parent", undefined, {
    rootDir: options.root,
    now: () => new Date(options.createdAt),
  });
  const spec = options.spec ?? { prompt: "original" };
  const resolved = options.resolved ?? {
    provider: "test-provider",
    modelId: "test-model",
    thinkingLevel: "high",
    tools: ["read"],
    cwd: options.cwd,
    label: "original",
  };
  const sessionFile = options.sessionFile === false ? undefined : join(store.sessionsDir, `${options.childId}.jsonl`);
  if (sessionFile) {
    mkdirSync(store.sessionsDir, { recursive: true });
    writeFileSync(sessionFile, "original transcript\n");
  }
  store.addChild(options.childId, spec);
  store.resolveChild(options.childId, resolved, sessionFile);
  const status = options.status ?? "completed";
  store.recordEvent({ type: "status", id: options.childId, status });
  if (status === "running" || status === "pending") store.releaseOwnership();
  if (options.version === 2) {
    const runPath = join(store.runDir, "run.json");
    const record = JSON.parse(readFileSync(runPath, "utf8"));
    record.v = 2;
    delete record.delivery;
    writeFileSync(runPath, `${JSON.stringify(record)}\n`);
  } else if (sessionFile && status !== "running" && status !== "pending" && options.sessionClosed !== false) {
    writeSessionClosedMarker(store.runDir, options.childId);
  }
  return sessionFile;
}

describe("follow-up resolution", () => {
  test("reconstructs execution config from submitted and resolved fields without schema tools", () => {
    const root = mkdtempSync(join(tmpdir(), "follow-up-resolution-"));
    const cwd = "/work/follow-up-resolution";
    const sourceSpec: SubagentSpec = {
      prompt: "original task",
      model: "submitted/ignored",
      thinkingLevel: "low",
      tools: ["read", "report_result"],
      excludeTools: ["bash"],
      schema: { type: "object" },
      cwd: "/submitted/cwd",
      label: "source label",
    };
    const sourceResolved: ResolvedSpec = {
      provider: "resolved-provider",
      modelId: "resolved-model",
      thinkingLevel: "xhigh",
      tools: ["read", "report_result"],
      cwd: "/resolved/cwd",
      label: "resolved label",
    };
    const sessionFile = historicalChild({
      root, cwd, runId: "run-source", childId: "child-source", createdAt: "2026-07-15T10:00:00.000Z",
      spec: sourceSpec, resolved: sourceResolved,
    });

    expect(resolveFollowUpSpec("child-source", "continue", cwd, root)).toEqual({
      spec: {
        prompt: "continue",
        model: "resolved-provider/resolved-model",
        thinkingLevel: "xhigh",
        tools: ["read"],
        excludeTools: ["bash"],
        cwd: "/submitted/cwd",
        label: "source label",
      },
      forkSessionFile: sessionFile!,
      followUpOf: { runId: "run-source", childId: "child-source" },
    });
  });

  test("preserves an extension-provided report_result tool for a non-schema source", () => {
    const root = mkdtempSync(join(tmpdir(), "follow-up-extension-tool-"));
    const cwd = "/work/follow-up-extension-tool";
    historicalChild({
      root, cwd, runId: "run-source", childId: "child-source", createdAt: "2026-07-15T10:00:00.000Z",
      spec: { prompt: "original task", tools: ["read", "report_result"] },
    });

    expect(resolveFollowUpSpec("child-source", "continue", cwd, root).spec.tools)
      .toEqual(["read", "report_result"]);
  });

  test("rejects worktree-origin children", () => {
    const root = mkdtempSync(join(tmpdir(), "follow-up-worktree-"));
    const cwd = "/work/follow-up-worktree";
    historicalChild({
      root, cwd, runId: "run-worktree", childId: "child-worktree", createdAt: "2026-07-15T10:00:00.000Z",
      spec: { prompt: "edit", isolation: "worktree" },
      resolved: {
        provider: "test-provider", modelId: "test-model", thinkingLevel: "high", tools: [],
        cwd: "/deleted/worktree", label: "editor", worktreePath: "/deleted/worktree",
      },
    });

    expect(() => resolveFollowUpSpec("child-worktree", "continue", cwd, root))
      .toThrow("worktree-origin children cannot be continued");
  });

  test("reconciles a terminal event after a stale status write and rejects quarantined runs", () => {
    const root = mkdtempSync(join(tmpdir(), "follow-up-reconciliation-"));
    const cwd = "/work/follow-up-reconciliation";
    historicalChild({
      root, cwd, runId: "run-reconciled", childId: "reconciled", createdAt: "2026-07-15T10:00:00.000Z",
    });
    const runDir = join(root, encodeCwd(cwd), "run-reconciled");
    writeFileSync(join(runDir, "status.json"), JSON.stringify({
      status: "running",
      children: {
        reconciled: {
          status: "running",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        },
      },
    }));

    expect(resolveFollowUpSpec("reconciled", "continue", cwd, root).followUpOf)
      .toEqual({ runId: "run-reconciled", childId: "reconciled" });

    writeFileSync(join(runDir, "generation.pending"), "{}\n");
    expect(() => resolveFollowUpSpec("reconciled", "continue", cwd, root))
      .toThrow("source run is quarantined by generation.pending");
  });

  test("requires confirmed closure for v3 sources but preserves v2 compatibility", () => {
    const root = mkdtempSync(join(tmpdir(), "follow-up-closure-protocol-"));
    const cwd = "/work/follow-up-closure-protocol";
    historicalChild({
      root, cwd, runId: "run-v3", childId: "v3-child", createdAt: "2026-07-15T10:00:00.000Z",
      sessionClosed: false,
    });
    historicalChild({
      root, cwd, runId: "run-v2", childId: "v2-child", createdAt: "2026-07-15T09:00:00.000Z",
      version: 2,
    });

    expect(() => resolveFollowUpSpec("v3-child", "continue", cwd, root))
      .toThrow("source session closure is not confirmed; wait for child shutdown to finish and retry");
    expect(resolveFollowUpSpec("v2-child", "continue", cwd, root).followUpOf)
      .toEqual({ runId: "run-v2", childId: "v2-child" });
  });

  test("upgrading a v2 workflow backfills closure markers without stranding legacy follow-ups", () => {
    const root = mkdtempSync(join(tmpdir(), "follow-up-v2-upgrade-"));
    const cwd = "/work/follow-up-v2-upgrade";
    const runId = "workflow-v2-upgrade";
    const childId = "legacy-child";
    const source = new RunStore(runId, cwd, "parent", undefined, {
      rootDir: root,
      kind: "workflow",
    });
    source.startWorkflowGeneration("return null;", undefined);
    source.addChild(childId, { prompt: "legacy task", label: "legacy" });
    const sessionFile = join(source.sessionsDir, `${childId}.jsonl`);
    writeFileSync(sessionFile, "legacy transcript\n");
    source.resolveChild(childId, {
      provider: "test-provider",
      modelId: "test-model",
      thinkingLevel: "high",
      tools: ["read"],
      cwd,
      label: "legacy resolved",
    }, sessionFile);
    source.recordEvent({ type: "status", id: childId, status: "completed" });
    source.workflowFinished("completed");
    source.releaseOwnership();

    const runPath = join(source.runDir, "run.json");
    const legacyRecord = JSON.parse(readFileSync(runPath, "utf8"));
    legacyRecord.v = 2;
    delete legacyRecord.delivery;
    writeFileSync(runPath, `${JSON.stringify(legacyRecord)}\n`);
    expect(hasSessionClosedMarker(source.runDir, childId)).toBe(false);

    const resumed = new RunStore(runId, cwd, "parent", undefined, {
      rootDir: root,
      kind: "workflow",
      existingRunDir: source.runDir,
    });
    resumed.startWorkflowGeneration("return null;", undefined, {}, { requireExistingScript: true });
    expect(hasSessionClosedMarker(source.runDir, childId)).toBe(true);
    expect(JSON.parse(readFileSync(runPath, "utf8")).v).toBe(3);
    resumed.releaseOwnership();

    expect(resolveFollowUpSpec(`${runId}/${childId}`, "continue", cwd, root).followUpOf)
      .toEqual({ runId, childId });
  });

  test("bare missing-id lookup reads only run metadata across unrelated runs", () => {
    const root = mkdtempSync(join(tmpdir(), "follow-up-metadata-scan-"));
    const cwd = "/work/follow-up-metadata-scan";
    for (let index = 0; index < 4; index += 1) {
      historicalChild({
        root,
        cwd,
        runId: `run-${index}`,
        childId: `other-${index}`,
        createdAt: `2026-07-15T0${index}:00:00.000Z`,
      });
    }
    const recordReads: string[] = [];
    let snapshotReads = 0;

    expect(() => resolveFollowUpSpec("missing", "continue", cwd, root, {
      readRecord: (runDir) => {
        recordReads.push(runDir);
        return JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
      },
      readSnapshot: (runDir) => {
        snapshotReads += 1;
        return readRunSnapshot(runDir, (path) => {
          if (!path.endsWith("run.json")) throw new Error(`unexpected non-metadata read: ${path}`);
          return readFileSync(path, "utf8");
        });
      },
    })).toThrow("No child");

    expect(recordReads).toHaveLength(4);
    expect(snapshotReads).toBe(0);
  });

  test("reports unknown, ambiguous, non-terminal, and missing-session children", () => {
    const root = mkdtempSync(join(tmpdir(), "follow-up-errors-"));
    const cwd = "/work/follow-up-errors";
    historicalChild({ root, cwd, runId: "run-older", childId: "duplicate", createdAt: "2026-07-15T09:00:00.000Z" });
    historicalChild({ root, cwd, runId: "run-newer", childId: "duplicate", createdAt: "2026-07-15T11:00:00.000Z" });
    const liveStore = new RunStore("run-live", cwd, "parent", undefined, {
      rootDir: root,
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });
    const liveSession = join(liveStore.sessionsDir, "live.jsonl");
    writeFileSync(liveSession, "live transcript\n");
    liveStore.addChild("live", { prompt: "live" });
    liveStore.resolveChild("live", {
      provider: "test-provider", modelId: "test-model", thinkingLevel: "high", tools: [], cwd, label: "live",
    }, liveSession);
    liveStore.recordEvent({ type: "status", id: "live", status: "running" });
    historicalChild({ root, cwd, runId: "run-no-session", childId: "no-session", createdAt: "2026-07-15T13:00:00.000Z", sessionFile: false });

    try {
      expect(() => resolveFollowUpSpec("unknown", "continue", cwd, root)).toThrow("No child");
      expect(() => resolveFollowUpSpec("duplicate", "continue", cwd, root))
        .toThrow("run-newer/duplicate, run-older/duplicate");
      expect(resolveFollowUpSpec("run-older/duplicate", "continue", cwd, root).followUpOf)
        .toEqual({ runId: "run-older", childId: "duplicate" });
      expect(() => resolveFollowUpSpec("live", "continue", cwd, root)).toThrow("child is not terminal");
      expect(() => resolveFollowUpSpec("no-session", "continue", cwd, root)).toThrow("sessionFile is missing");
    } finally {
      liveStore.releaseOwnership();
    }
  });
});

describe("model reference parsing", () => {
  const registry = { getAll: () => [
    { provider: "openai-codex", id: "gpt-5.6-luna" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
    { provider: "other", id: "gpt-5.6-sol" },
  ] } as never;

  test("qualified ids parse; bare ids are rejected with a self-healing suggestion", () => {
    expect(parseModel("openai-codex/gpt-5.6-luna", registry)).toEqual(["openai-codex", "gpt-5.6-luna"]);
    expect(() => parseModel("gpt-5.6-luna", registry)).toThrow('e.g. "openai-codex/gpt-5.6-luna"');
    expect(() => parseModel("gpt-5.6-luna", registry)).toThrow("omit model to inherit");
  });

  test("ambiguous bare ids list every provider match; unknown ids get the format only", () => {
    expect(() => parseModel("gpt-5.6-sol", registry)).toThrow('matches: "openai-codex/gpt-5.6-sol", "other/gpt-5.6-sol"');
    expect(() => parseModel("made-up", registry)).toThrow('Expected "provider/model-id", or omit model');
  });

  test("only an omitted model inherits the parent model", () => {
    const parentModel = { provider: "openai-codex", id: "gpt-5.6-luna" } as NonNullable<ExtensionContext["model"]>;
    const context = {
      model: parentModel,
      modelRegistry: {
        find: (provider: string, id: string) => provider === parentModel.provider && id === parentModel.id ? parentModel : undefined,
        getAll: () => [parentModel],
      },
    } as never;

    expect(resolveModel({ prompt: "inherits" }, context, "low")).toEqual({ model: parentModel, thinking: "low" });
    expect(() => resolveModel({ prompt: "must fail", model: "" }, context, "low"))
      .toThrow('Invalid model ""');
  });
});
