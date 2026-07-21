import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CALL_FINGERPRINT_VERSION,
  describeFingerprintDrift,
  hashAgentPayload,
  isCallFingerprint,
  isInCausalTail,
  JournalUnreadableError,
  journalCallKey,
  readJournal,
  type CallFingerprint,
} from "../src/workflow/journal.js";

export function testFingerprint(overrides: Partial<CallFingerprint> = {}): CallFingerprint {
  return {
    version: CALL_FINGERPRINT_VERSION,
    provider: "test",
    modelId: "tiny",
    thinkingLevel: "off",
    cwd: "/repo",
    extensionTools: [],
    ...overrides,
  };
}

function entryLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    v: 4,
    call: { scope: [], operation: 0 },
    hash: "hash",
    fingerprint: testFingerprint(),
    result: "value",
    childId: "child",
    ...overrides,
  });
}

test("journal hash is stable across object key order and includes phase", () => {
  expect(hashAgentPayload({ prompt: "x", opts: { model: "m", tools: ["read"] }, phase: "A" }))
    .toBe(hashAgentPayload({ phase: "A", opts: { tools: ["read"], model: "m" }, prompt: "x" }));
  expect(hashAgentPayload({ prompt: "x", opts: {}, phase: "A" })).not.toBe(hashAgentPayload({ prompt: "x", opts: {}, phase: "B" }));
});

test("journal call keys are stable and causal invalidation preserves sibling branches", () => {
  const miss = { scope: [{ operation: 1, branch: 0, kind: "pipeline" as const }], operation: 0 };
  const sameBranchLater = { scope: [{ operation: 1, branch: 0, kind: "pipeline" as const }], operation: 1 };
  const descendant = {
    scope: [
      { operation: 1, branch: 0, kind: "pipeline" as const },
      { operation: 2, branch: 0, kind: "parallel" as const },
    ],
    operation: 0,
  };
  const sibling = { scope: [{ operation: 1, branch: 1, kind: "pipeline" as const }], operation: 0 };
  const afterJoin = { scope: [], operation: 2 };
  const removedGroupOrigin = { scope: [{ operation: 1, branch: 0, kind: "parallel" as const }], operation: 0 };
  const replacementAtGroupIdentity = { scope: [], operation: 1 };
  expect(journalCallKey(miss)).toBe(journalCallKey({ operation: 0, scope: [{ kind: "pipeline", branch: 0, operation: 1 }] }));
  expect(isInCausalTail(sameBranchLater, miss)).toBe(true);
  expect(isInCausalTail(descendant, miss)).toBe(true);
  expect(isInCausalTail(sibling, miss)).toBe(false);
  expect(isInCausalTail(afterJoin, miss)).toBe(true);
  expect(isInCausalTail(replacementAtGroupIdentity, removedGroupOrigin)).toBe(true);
});

test("readJournal accepts current v4 entries", () => {
  const path = join(mkdtempSync(join(tmpdir(), "workflow-journal-version-")), "journal.jsonl");
  const lines = [
    entryLine({ result: "first" }),
    entryLine({ call: { scope: [], operation: 1 }, result: "second", childId: "second-child" }),
  ];
  writeFileSync(path, lines.join("\n") + "\n");

  expect([...readJournal(path).entries.values()].map((entry) => entry.result)).toEqual(["first", "second"]);
});

test("readJournal rejects pre-fingerprint entries as a format break", () => {
  const path = join(mkdtempSync(join(tmpdir(), "workflow-journal-legacy-")), "journal.jsonl");
  const legacy = [
    { call: { scope: [], operation: 0 }, hash: "old", result: "old", childId: "old-child" },
    { v: 2, call: { scope: [], operation: 1 }, hash: "new", result: "new", childId: "new-child" },
  ];
  for (const entry of legacy) {
    writeFileSync(path, `${JSON.stringify(entry)}\n`);
    expect(() => readJournal(path)).toThrow(
      `Cannot resume workflow: journal ${path} line 1 predates the current format, so this run cannot be resumed. Re-run the workflow fresh.`,
    );
  }
});

test("readJournal rejects budget-era v3 entries as a format break", () => {
  const path = join(mkdtempSync(join(tmpdir(), "workflow-journal-v3-")), "journal.jsonl");
  writeFileSync(path, `${JSON.stringify({
    v: 3,
    call: { scope: [], operation: 0 },
    hash: "old",
    fingerprint: testFingerprint(),
    result: "old",
    childId: "old-child",
    usage: { input: 1, output: 1 },
  })}\n`);
  expect(() => readJournal(path)).toThrow("predates the current format");
});

test("readJournal rejects a v4 entry with a malformed fingerprint", () => {
  const path = join(mkdtempSync(join(tmpdir(), "workflow-journal-bad-print-")), "journal.jsonl");
  writeFileSync(path, entryLine({ fingerprint: { version: 1, provider: 7 } }) + "\n");

  expect(() => readJournal(path)).toThrow(
    `Cannot resume workflow: journal ${path} line 1 is unreadable because the entry does not match the current format. Re-run the workflow fresh.`,
  );
});

test("readJournal refuses invalid JSON on an interior line", () => {
  const path = join(mkdtempSync(join(tmpdir(), "workflow-journal-corrupt-")), "journal.jsonl");
  writeFileSync(path, `${entryLine({ result: "first" })}\n{broken\n${entryLine({ call: { scope: [], operation: 1 }, result: "third" })}\n`);

  let error: unknown;
  try {
    readJournal(path);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(JournalUnreadableError);
  expect((error as Error).message).toBe(
    `Cannot resume workflow: journal ${path} line 2 is unreadable because it contains invalid JSON. Re-run the workflow fresh.`,
  );
});

test("readJournal tolerates invalid JSON on an unterminated final line", () => {
  const path = join(mkdtempSync(join(tmpdir(), "workflow-journal-torn-tail-")), "journal.jsonl");
  writeFileSync(path, `${entryLine({ result: "first" })}\n{broken`);

  const journal = readJournal(path);
  expect([...journal.entries.values()].map((entry) => entry.result)).toEqual(["first"]);
  expect(journal.tornTail).toBe(true);
});

test("readJournal refuses invalid JSON on a newline-terminated final line", () => {
  const path = join(mkdtempSync(join(tmpdir(), "workflow-journal-complete-tail-")), "journal.jsonl");
  writeFileSync(path, `${entryLine({ result: "first" })}\n{broken\n`);

  let error: unknown;
  try {
    readJournal(path);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(JournalUnreadableError);
  expect((error as Error).message).toBe(
    `Cannot resume workflow: journal ${path} line 2 is unreadable because it contains invalid JSON. Re-run the workflow fresh.`,
  );
});

test("readJournal refuses parsed entries outside the current format", () => {
  const path = join(mkdtempSync(join(tmpdir(), "workflow-journal-shape-")), "journal.jsonl");
  writeFileSync(path, "{}\n");

  expect(() => readJournal(path)).toThrow(
    `Cannot resume workflow: journal ${path} line 1 is unreadable because the entry does not match the current format. Re-run the workflow fresh.`,
  );
});

test("isCallFingerprint validates the full current shape and tolerates legacy extras", () => {
  expect(isCallFingerprint(testFingerprint())).toBe(true);
  expect(isCallFingerprint(testFingerprint({ extensionTools: ["fetch_content", "web_search"] }))).toBe(true);
  expect(isCallFingerprint({ ...testFingerprint(), childExtensionExclusions: ["todo"] })).toBe(true);
  expect(isCallFingerprint(undefined)).toBe(false);
  expect(isCallFingerprint({ ...testFingerprint(), version: "1" })).toBe(false);
  expect(isCallFingerprint({ ...testFingerprint(), extensionTools: [7] })).toBe(false);
  const missingCwd: Record<string, unknown> = { ...testFingerprint() };
  delete missingCwd.cwd;
  expect(isCallFingerprint(missingCwd)).toBe(false);
});

test("describeFingerprintDrift names every differing field and only those", () => {
  const persisted = testFingerprint({ extensionTools: ["fetch_content"] });
  expect(describeFingerprintDrift(persisted, testFingerprint({ extensionTools: ["fetch_content"] }))).toEqual([]);

  const drift = describeFingerprintDrift(persisted, testFingerprint({
    modelId: "large",
    extensionTools: ["fetch_content", "web_search"],
  }));
  expect(drift).toHaveLength(2);
  expect(drift[0]).toBe('modelId was "tiny" and is now "large"');
  expect(drift[1]).toBe('extensionTools was ["fetch_content"] and is now ["fetch_content","web_search"]');
});

test("describeFingerprintDrift reports a version epoch change", () => {
  expect(describeFingerprintDrift(testFingerprint(), testFingerprint({ version: CALL_FINGERPRINT_VERSION + 1 })))
    .toEqual([`version was ${CALL_FINGERPRINT_VERSION} and is now ${CALL_FINGERPRINT_VERSION + 1}`]);
});
