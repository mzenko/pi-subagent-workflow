import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PLAIN, type ThemeLike } from "../src/ui/format.js";
import { boundedJsonPreview, UNTRUSTED_FIELD_MAX } from "../src/ui/sanitize.js";
import {
  LARGE_RECORD_SCAN_OMISSION,
  messagesToLines,
  OVERSIZED_MESSAGE_OMISSION,
  OVERSIZED_RECORD_OMISSION,
  readSessionMessages,
  SESSION_ENTRY_MAX_BYTES,
  SESSION_RECORD_MAX_COUNT,
  SESSION_SCAN_MAX_BYTES,
  sessionEntriesToMessages,
  TRANSCRIPT_MAX_LINES,
  UNSCANNED_TRANSCRIPT_OMISSION,
} from "../src/ui/navigator/transcript.js";

function exactAssistantRecord(byteLength: number, prefix: string): { record: string; content: string } {
  const empty = JSON.stringify({ type: "message", message: { role: "assistant", content: "" } });
  const content = `${prefix}${"x".repeat(byteLength - Buffer.byteLength(empty) - prefix.length)}`;
  const record = JSON.stringify({ type: "message", message: { role: "assistant", content } });
  expect(Buffer.byteLength(record)).toBe(byteLength);
  return { record, content };
}

/** A minimal but realistic persisted pi session file (header + three messages). */
function writeFixtureSession(): string {
  const dir = mkdtempSync(join(tmpdir(), "nav-session-"));
  const path = join(dir, "child.jsonl");
  const lines = [
    JSON.stringify({ type: "session_info", id: "h", parentId: null, timestamp: "t0", name: "child" }),
    JSON.stringify({ type: "message", id: "1", parentId: "h", timestamp: "t1", message: { role: "user", content: "Investigate the flaky test", timestamp: 1 } }),
    JSON.stringify({
      type: "message", id: "2", parentId: "1", timestamp: "t2",
      message: { role: "assistant", content: [{ type: "text", text: "Looking into it." }, { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls -a" } }], timestamp: 2 },
    }),
    JSON.stringify({
      type: "message", id: "3", parentId: "2", timestamp: "t3",
      message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "file-a\nfile-b" }], isError: false, timestamp: 3 },
    }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function splitTerminalStringParts(first: string): Array<{ type: "text"; text: string }> {
  return [
    { type: "text", text: `${first}\u001b` },
    { type: "text", text: "]osc secret\u0007after osc\u001b" },
    { type: "text", text: "Pdcs secret\u001b\\after dcs\u001b" },
    { type: "text", text: "_apc secret\u001b\\after apc\u001b" },
    { type: "text", text: "Xsos secret\u001b\\after sos\u001b" },
    { type: "text", text: "^pm secret\u001b\\after pm" },
  ];
}

test("readSessionMessages parses a session smaller than one scan chunk", () => {
  const messages = readSessionMessages(writeFixtureSession());
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
});

test("readSessionMessages returns an unavailable placeholder for a missing file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "missing.jsonl");
  expect(readSessionMessages(path)).toEqual([
    { role: "assistant", content: "(session transcript unavailable: could not read session file)" },
  ]);
});

test("readSessionMessages returns no messages for an empty file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "empty.jsonl");
  writeFileSync(path, "");
  expect(readSessionMessages(path)).toEqual([]);
});

test("readSessionMessages returns a placeholder for malformed session input", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-session-"));
  const path = join(dir, "malformed.jsonl");
  writeFileSync(path, "{not valid json\n");

  expect(() => readSessionMessages(path)).not.toThrow();
  expect(readSessionMessages(path)).toEqual([
    { role: "assistant", content: "(session transcript unavailable: malformed session file)" },
  ]);
});

test("readSessionMessages marks an oversized complete message in chronological position", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-session-"));
  const path = join(dir, "oversized.jsonl");
  const older = { type: "message", message: { role: "assistant", content: "older survives" } };
  const oversized = { type: "message", message: { role: "toolResult", content: "x".repeat(512 * 1024) } };
  writeFileSync(path, `${JSON.stringify(older)}\n${JSON.stringify(oversized)}\n`);

  expect(readSessionMessages(path)).toEqual([
    { role: "assistant", content: "older survives" },
    { role: "toolResult", content: OVERSIZED_MESSAGE_OMISSION, toolName: "result" },
  ]);
});

test("readSessionMessages preserves one bounded marker for each oversized complete message", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "oversized-order.jsonl");
  const entries = [
    { type: "message", message: { role: "user", content: "before" } },
    { type: "message", message: { role: "assistant", content: "x".repeat(SESSION_ENTRY_MAX_BYTES) } },
    { type: "message", message: { role: "assistant", content: "between" } },
    { type: "message", message: { role: "toolResult", content: "y".repeat(SESSION_ENTRY_MAX_BYTES) } },
    { type: "message", message: { role: "user", content: "after" } },
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const messages = readSessionMessages(path);
  expect(messages.map((message) => message.content)).toEqual([
    "before",
    OVERSIZED_MESSAGE_OMISSION,
    "between",
    OVERSIZED_MESSAGE_OMISSION,
    "after",
  ]);
  expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "toolResult", "user"]);
});

test("oversized placeholders preserve user, assistant, and tool-result rendering roles", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "oversized-roles.jsonl");
  const entries = [
    { type: "message", message: { role: "user", content: "u".repeat(SESSION_ENTRY_MAX_BYTES) } },
    { type: "message", message: { role: "assistant", content: "a".repeat(SESSION_ENTRY_MAX_BYTES) } },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: "t".repeat(SESSION_ENTRY_MAX_BYTES),
        isError: false,
      },
    },
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const messages = readSessionMessages(path);
  expect(messages).toEqual([
    { role: "user", content: OVERSIZED_MESSAGE_OMISSION },
    { role: "assistant", content: OVERSIZED_MESSAGE_OMISSION },
    { role: "toolResult", content: OVERSIZED_MESSAGE_OMISSION, toolName: "bash" },
  ]);
  const lines = messagesToLines(messages, PLAIN, 80);
  expect(lines).toContain("▌ user");
  expect(lines).toContain("● assistant");
  expect(lines).toContain("  ↳ bash");
  expect(lines.filter((line) => line.includes(OVERSIZED_MESSAGE_OMISSION))).toHaveLength(3);
});

test("oversized role classification is independent of nested message key order", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "oversized-reordered-roles.jsonl");
  const entries = [
    { type: "message", message: { timestamp: 1, role: "user", content: "u".repeat(SESSION_ENTRY_MAX_BYTES) } },
    { type: "message", message: { timestamp: 2, role: "assistant", content: "a".repeat(SESSION_ENTRY_MAX_BYTES) } },
    { type: "message", message: { toolName: "read", timestamp: 3, role: "toolResult", content: "t".repeat(SESSION_ENTRY_MAX_BYTES) } },
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  expect(readSessionMessages(path)).toEqual([
    { role: "user", content: OVERSIZED_MESSAGE_OMISSION },
    { role: "assistant", content: OVERSIZED_MESSAGE_OMISSION },
    { role: "toolResult", content: OVERSIZED_MESSAGE_OMISSION, toolName: "read" },
  ]);
});

test("oversized prefix classification skips proven non-messages but preserves uncertain and proven messages", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "oversized-prefix-classification.jsonl");
  const entries = [
    { type: "model_change", payload: "n".repeat(SESSION_ENTRY_MAX_BYTES) },
    { payload: "u".repeat(SESSION_ENTRY_MAX_BYTES), type: "model_change" },
    { type: "message", message: { role: "assistant", content: "m".repeat(SESSION_ENTRY_MAX_BYTES) } },
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  expect(readSessionMessages(path)).toEqual([
    // Type was beyond the prefix: honestly a record omission, not a message claim.
    { role: "omission", content: OVERSIZED_RECORD_OMISSION },
    { role: "assistant", content: OVERSIZED_MESSAGE_OMISSION },
  ]);
});

test("oversized message-first records preserve generic chronological markers when type is beyond the prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-session-"));
  const reordered = [
    { message: { role: "user", content: "u".repeat(SESSION_ENTRY_MAX_BYTES) }, type: "message" },
    { message: { role: "assistant", content: "a".repeat(SESSION_ENTRY_MAX_BYTES) }, type: "message" },
    {
      message: { role: "toolResult", toolName: "bash", content: "t".repeat(SESSION_ENTRY_MAX_BYTES) },
      type: "message",
    },
  ];
  const standalone = join(dir, "standalone-message-first.jsonl");
  writeFileSync(standalone, `${JSON.stringify(reordered[1])}\n`);
  expect(readSessionMessages(standalone)).toEqual([
    { role: "omission", content: OVERSIZED_RECORD_OMISSION },
  ]);

  const mixed = join(dir, "mixed-message-first.jsonl");
  writeFileSync(mixed, [
    JSON.stringify({ type: "message", message: { role: "assistant", content: "before" } }),
    ...reordered.map((entry) => JSON.stringify(entry)),
    JSON.stringify({ type: "message", message: { role: "user", content: "after" } }),
    "",
  ].join("\n"));
  expect(readSessionMessages(mixed)).toEqual([
    { role: "assistant", content: "before" },
    { role: "omission", content: OVERSIZED_RECORD_OMISSION },
    { role: "omission", content: OVERSIZED_RECORD_OMISSION },
    { role: "omission", content: OVERSIZED_RECORD_OMISSION },
    { role: "user", content: "after" },
  ]);
});

test("oversized nested values that exhaust the prefix retain an omission slot", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "oversized-nested-prefix.jsonl");
  const oversized = {
    message: {
      metadata: { padding: "p".repeat(300) },
      role: "assistant",
      content: "x".repeat(SESSION_ENTRY_MAX_BYTES),
    },
    type: "message",
  };
  writeFileSync(path, [
    JSON.stringify({ type: "message", message: { role: "user", content: "before" } }),
    JSON.stringify(oversized),
    JSON.stringify({ type: "message", message: { role: "assistant", content: "after" } }),
    "",
  ].join("\n"));

  expect(readSessionMessages(path)).toEqual([
    { role: "user", content: "before" },
    { role: "omission", content: OVERSIZED_RECORD_OMISSION },
    { role: "assistant", content: "after" },
  ]);
});

test("oversized messages with role beyond the bounded prefix keep a generic chronological marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-session-"));
  const oversized = {
    type: "message",
    message: { prefixPadding: "p".repeat(300), role: "assistant", content: "x".repeat(SESSION_ENTRY_MAX_BYTES) },
  };
  const standalone = join(dir, "standalone.jsonl");
  writeFileSync(standalone, `${JSON.stringify(oversized)}\n`);
  expect(readSessionMessages(standalone)).toEqual([{ role: "omission", content: OVERSIZED_MESSAGE_OMISSION }]);

  const mixed = join(dir, "mixed.jsonl");
  writeFileSync(mixed, [
    JSON.stringify({ type: "message", message: { role: "user", content: "before" } }),
    JSON.stringify(oversized),
    JSON.stringify({ type: "message", message: { role: "assistant", content: "after" } }),
    "",
  ].join("\n"));
  expect(readSessionMessages(mixed)).toEqual([
    { role: "user", content: "before" },
    { role: "omission", content: OVERSIZED_MESSAGE_OMISSION },
    { role: "assistant", content: "after" },
  ]);
});

test("readSessionMessages bounds byte work inside a giant newest complete record", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "giant-newest.jsonl");
  const older = JSON.stringify({ type: "message", message: { role: "assistant", content: "must stay hidden" } });
  const giant = JSON.stringify({
    type: "message",
    message: { role: "assistant", content: "x".repeat(SESSION_SCAN_MAX_BYTES + 1024 * 1024) },
  });
  writeFileSync(path, `${older}\n${giant}\n`);

  const messages = readSessionMessages(path);

  expect(messages).toEqual([{ role: "omission", content: LARGE_RECORD_SCAN_OMISSION }]);
  expect(messagesToLines(messages, PLAIN, 80).join("\n")).toContain("a large session record and older records not scanned");
});

test("readSessionMessages bounds byte work inside a giant unterminated newest record", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "giant-partial.jsonl");
  const older = JSON.stringify({ type: "message", message: { role: "user", content: "must stay hidden" } });
  const partial = JSON.stringify({
    type: "message",
    message: { role: "assistant", content: "x".repeat(SESSION_SCAN_MAX_BYTES + 1024 * 1024) },
  }).slice(0, -1);
  writeFileSync(path, `${older}\n${partial}`);

  expect(readSessionMessages(path)).toEqual([{ role: "omission", content: LARGE_RECORD_SCAN_OMISSION }]);
});

test("scan omission stays before newer chronology when the byte cap lands in older history", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "giant-older.jsonl");
  const oldest = JSON.stringify({ type: "message", message: { role: "user", content: "unscanned oldest" } });
  const giant = JSON.stringify({
    type: "message",
    message: { role: "assistant", content: "x".repeat(SESSION_SCAN_MAX_BYTES + 1024 * 1024) },
  });
  const newest = JSON.stringify({ type: "message", message: { role: "assistant", content: "newest survives" } });
  writeFileSync(path, `${oldest}\n${giant}\n${newest}\n`);

  expect(readSessionMessages(path)).toEqual([
    { role: "omission", content: LARGE_RECORD_SCAN_OMISSION },
    { role: "assistant", content: "newest survives" },
  ]);
});

test("a small record split by the scan boundary uses the generic omission marker", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "small-boundary-fragment.jsonl");
  const older = exactAssistantRecord(128, "small-older-");
  const boundaryFragmentBytes = 8;
  const newer = exactAssistantRecord(SESSION_SCAN_MAX_BYTES - boundaryFragmentBytes - 2, "oversized-newer-");
  writeFileSync(path, `${older.record}\n${newer.record}\n`);

  expect(readSessionMessages(path)).toEqual([
    { role: "omission", content: UNSCANNED_TRANSCRIPT_OMISSION },
    { role: "assistant", content: OVERSIZED_MESSAGE_OMISSION },
  ]);
});

test("readSessionMessages does not mark an oversized trailing partial record", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "oversized-partial.jsonl");
  const complete = JSON.stringify({ type: "message", message: { role: "assistant", content: "complete" } });
  const partial = JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(SESSION_ENTRY_MAX_BYTES) } });
  writeFileSync(path, `${complete}\n${partial.slice(0, -1)}`);

  expect(readSessionMessages(path)).toEqual([{ role: "assistant", content: "complete" }]);
});

test("readSessionMessages does not mark an oversized leading fragment", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "oversized-leading-partial.jsonl");
  const fragment = `${"x".repeat(SESSION_ENTRY_MAX_BYTES)}\"}}`;
  const complete = JSON.stringify({ type: "message", message: { role: "assistant", content: "complete" } });
  writeFileSync(path, `${fragment}\n${complete}\n`);

  expect(readSessionMessages(path)).toEqual([{ role: "assistant", content: "complete" }]);
});

test("readSessionMessages reconstructs a record spanning scan chunks", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "spanning.jsonl");
  const content = `start-${"x".repeat(300 * 1024)}-end`;
  writeFileSync(path, `${JSON.stringify({ type: "message", message: { role: "assistant", content } })}\n`);

  expect(readSessionMessages(path)).toEqual([{ role: "assistant", content }]);
});

test("readSessionMessages accepts an exactly-maximal record terminated by CRLF within one chunk", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "maximal-crlf.jsonl");
  const { record, content } = exactAssistantRecord(SESSION_ENTRY_MAX_BYTES, "maximal-crlf-");
  writeFileSync(path, `${record}\r\n`);

  expect(readSessionMessages(path)).toEqual([{ role: "assistant", content }]);
});

test("readSessionMessages accepts an exactly-maximal record when CRLF straddles a scan chunk", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "boundary-crlf.jsonl");
  const { record, content } = exactAssistantRecord(SESSION_ENTRY_MAX_BYTES, "boundary-crlf-");
  // The newer record leaves exactly one scan chunk from the target LF to EOF,
  // placing that LF at byte zero and its CR in the preceding chunk.
  const newer = exactAssistantRecord(256 * 1024 - 2, "newer-");
  writeFileSync(path, `${record}\r\n${newer.record}\n`);

  expect(readSessionMessages(path)).toEqual([
    { role: "assistant", content },
    { role: "assistant", content: newer.content },
  ]);
});

test("readSessionMessages keeps LF-only exactly-maximal records unchanged", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "maximal-lf.jsonl");
  const { record, content } = exactAssistantRecord(SESSION_ENTRY_MAX_BYTES, "maximal-lf-");
  writeFileSync(path, `${record}\n`);

  expect(readSessionMessages(path)).toEqual([{ role: "assistant", content }]);
});

test("readSessionMessages silently skips a trailing partial record", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "partial.jsonl");
  writeFileSync(path, `${JSON.stringify({ type: "message", message: { role: "assistant", content: "complete" } })}\n{"type":"message"`);

  expect(readSessionMessages(path)).toEqual([{ role: "assistant", content: "complete" }]);
});

test("materialized-byte truncation emits one oldest omission before retained chronology", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "materialized-limit.jsonl");
  const entries = Array.from({ length: 5 }, (_, index) => exactAssistantRecord(500 * 1024, `entry-${index}-`));
  writeFileSync(path, `${entries.map(({ record }) => record).join("\n")}\n`);

  const messages = readSessionMessages(path);
  expect(messages).toEqual([
    { role: "omission", content: UNSCANNED_TRANSCRIPT_OMISSION },
    ...entries.slice(1).map(({ content }) => ({ role: "assistant", content })),
  ]);
});

test("message-count truncation emits one oldest omission before the newest 512 messages", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "message-count-limit.jsonl");
  const entries = Array.from({ length: 513 }, (_, index) => ({
    type: "message",
    message: { role: "assistant", content: `message-${index}` },
  }));
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const messages = readSessionMessages(path);
  expect(messages).toHaveLength(513);
  expect(messages[0]).toEqual({ role: "omission", content: UNSCANNED_TRANSCRIPT_OMISSION });
  expect(messages[1]?.content).toBe("message-1");
  expect(messages.at(-1)?.content).toBe("message-512");
});

test("message-count bound emits no omission when the file is consumed exactly", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "message-count-exact.jsonl");
  const entries = Array.from({ length: 512 }, (_, index) => ({
    type: "message",
    message: { role: "assistant", content: `message-${index}` },
  }));
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const messages = readSessionMessages(path);
  expect(messages).toHaveLength(512);
  expect(messages[0]?.content).toBe("message-0");
  expect(messages.at(-1)?.content).toBe("message-511");
});

test("completed-record budget bounds dense malformed history", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "dense-malformed.jsonl");
  writeFileSync(path, "{\n".repeat(SESSION_RECORD_MAX_COUNT + 100));

  expect(readSessionMessages(path)).toEqual([
    { role: "omission", content: UNSCANNED_TRANSCRIPT_OMISSION },
  ]);
});

test("completed-record budget skips dense valid non-message history", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "dense-non-message.jsonl");
  const nonMessage = JSON.stringify({ type: "model_change" });
  const newest = JSON.stringify({ type: "message", message: { role: "assistant", content: "newest survives" } });
  writeFileSync(path, `${`${nonMessage}\n`.repeat(SESSION_RECORD_MAX_COUNT + 100)}${newest}\n`);

  expect(readSessionMessages(path)).toEqual([
    { role: "omission", content: UNSCANNED_TRANSCRIPT_OMISSION },
    { role: "assistant", content: "newest survives" },
  ]);
});

test("readSessionMessages bounds work on a session larger than 10 MiB and returns the newest entries", () => {
  const path = join(mkdtempSync(join(tmpdir(), "nav-session-")), "large.jsonl");
  writeFileSync(path, Buffer.alloc(11 * 1024 * 1024, 0x78));
  appendFileSync(path, "\n");
  const recent = Array.from({ length: 600 }, (_, index) => JSON.stringify({
    type: "message",
    message: { role: "assistant", content: `recent-${index}` },
  }));
  appendFileSync(path, `${recent.join("\n")}\n`);

  const messages = readSessionMessages(path);
  expect(messages).toHaveLength(513);
  expect(messages[0]).toEqual({ role: "omission", content: UNSCANNED_TRANSCRIPT_OMISSION });
  expect(messages[1]?.content).toBe("recent-88");
  expect(messages.at(-1)?.content).toBe("recent-599");
});

test("sessionEntriesToMessages drops non-message entries", () => {
  const entries = [
    { type: "session_info", id: "h" },
    { type: "message", id: "1", message: { role: "user", content: "hi" } },
    { type: "model_change", id: "m" },
  ];
  expect(sessionEntriesToMessages(entries as never).map((m) => m.role)).toEqual(["user"]);
});

test("messagesToLines renders user, assistant text, tool calls, and results, width-clamped", () => {
  const messages = readSessionMessages(writeFixtureSession());
  const width = 50;
  const lines = messagesToLines(messages, PLAIN, width);
  const joined = lines.join("\n");
  expect(joined).toContain("▌ user");
  expect(joined).toContain("Investigate the flaky test");
  expect(joined).toContain("● assistant");
  expect(joined).toContain("Looking into it.");
  expect(joined).toContain("⚙ bash");
  expect(joined).toContain("↳ bash");
  expect(joined).toContain("file-a");
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
});

test("boundedJsonPreview bounds large values and marks cycles", () => {
  const cyclic: Record<string, unknown> = { command: "pwd" };
  cyclic.self = cyclic;
  expect(boundedJsonPreview(cyclic)).toBe('{"command":"pwd","self":"<cycle>"}');

  const preview = boundedJsonPreview({ command: "x".repeat(10_000) }, 40);
  expect(preview.length).toBeLessThanOrEqual(40);
  expect(preview.endsWith("…")).toBe(true);
});

test("tool-call previews support array arguments", () => {
  const lines = messagesToLines([{
    role: "assistant",
    content: [{ type: "toolCall", name: "batch", arguments: ["one", { two: 2 }] }],
  }], PLAIN, 80);
  expect(lines.join("\n")).toContain('⚙ batch ["one",{"two":2}]');
});

test("multipart user and tool-result text preserves visual logical line boundaries", () => {
  const lines = messagesToLines([
    {
      role: "user",
      content: [
        { type: "text", text: "user part one" },
        { type: "text", text: "user part two" },
      ],
    },
    {
      role: "toolResult",
      toolName: "bash",
      content: [
        { type: "text", text: "result part one" },
        { type: "text", text: "result part two" },
      ],
    },
  ], PLAIN, 80);

  expect(lines).toEqual([
    "▌ user",
    "user part one",
    "user part two",
    "─",
    "  ↳ bash",
    "    result part one",
    "    result part two",
  ]);
});

test("multipart user text keeps split terminal introducers in shared parser state", () => {
  const lines = messagesToLines([{
    role: "user",
    content: splitTerminalStringParts("visible user"),
  }], PLAIN, 80);

  expect(lines).toEqual([
    "▌ user",
    "visible user",
    "after osc",
    "after dcs",
    "after apc",
    "after sos",
    "after pm",
  ]);
  expect(lines.join("\n")).not.toContain("secret");
});

test("multipart tool-result text keeps split terminal introducers in shared parser state", () => {
  const lines = messagesToLines([{
    role: "toolResult",
    toolName: "bash",
    content: splitTerminalStringParts("visible result"),
  }], PLAIN, 80);

  expect(lines).toEqual([
    "  ↳ bash",
    "    visible result",
    "    after osc",
    "    after dcs",
    "    after apc",
    "    after sos",
    "    after pm",
  ]);
  expect(lines.join("\n")).not.toContain("secret");
});

test("messagesToLines preserves logical newlines across transcript content kinds", () => {
  const lines = messagesToLines([
    { role: "user", content: "user line one\nuser line two" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "assistant line one\nassistant line two" },
        { type: "thinking", thinking: "thinking line one\nthinking line two" },
      ],
    },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "result line one\nresult line two" }] },
  ], PLAIN, 80);

  expect(lines).toContain("user line one");
  expect(lines).toContain("user line two");
  expect(lines).toContain("assistant line one");
  expect(lines).toContain("assistant line two");
  expect(lines).toContain("thinking line one");
  expect(lines).toContain("thinking line two");
  expect(lines).toContain("    result line one");
  expect(lines).toContain("    result line two");
  expect(lines.join("\n")).not.toContain("line oneuser line two");
});

test("messagesToLines suppresses multiline OSC, DCS, and APC payloads without losing ground-state newlines", () => {
  const content = [
    "visible start",
    "\u001b]0;osc secret one\r\nosc secret two\u0007visible after osc",
    "\u0090dcs secret one\u0007dcs secret two\ndcs secret three\u009cvisible after dcs",
    "\u001b_apc secret one\u0007apc secret two\rapc secret three\u001b\\visible after apc",
  ].join("\r\n");

  const lines = messagesToLines([{ role: "assistant", content }], PLAIN, 80);
  expect(lines).toEqual([
    "● assistant",
    "visible start",
    "visible after osc",
    "visible after dcs",
    "visible after apc",
  ]);
  expect(lines.join("\n")).not.toContain("secret");
});

test("dense-newline live and persisted transcripts have bounded rows and bounded tool output", () => {
  const dense = `${"x\n".repeat(UNTRUSTED_FIELD_MAX / 2 - 1)}tail`;
  const message = { role: "assistant", content: dense };
  const liveLines = messagesToLines([message], PLAIN, 37);

  const dir = mkdtempSync(join(tmpdir(), "nav-session-dense-"));
  const path = join(dir, "child.jsonl");
  writeFileSync(path, `${JSON.stringify({ type: "message", message })}\n`);
  const persistedLines = messagesToLines(readSessionMessages(path), PLAIN, 37);

  for (const lines of [liveLines, persistedLines]) {
    expect(lines.length).toBe(TRANSCRIPT_MAX_LINES);
    expect(lines[0]).toBe("(transcript elided)");
    expect(lines.at(-1)).toBe("tail");
    expect(lines.every((line) => visibleWidth(line) <= 37)).toBe(true);
  }

  const toolLines = messagesToLines([
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: dense }] },
  ], PLAIN, 37);
  expect(toolLines.length).toBe(12);
  expect(toolLines[1]).toBe("    … earlier lines elided");
  expect(toolLines.at(-1)).toBe("    tail");
});

test("messagesToLines retains the newest live transcript tail", () => {
  const messages = Array.from({ length: TRANSCRIPT_MAX_LINES }, (_, index) => ({
    role: "assistant",
    content: `message-${index}`,
  }));
  const lines = messagesToLines(messages, PLAIN, 80);
  const joined = `\n${lines.join("\n")}\n`;

  expect(lines.length).toBeLessThanOrEqual(TRANSCRIPT_MAX_LINES);
  expect(lines[0]).toBe("(transcript elided)");
  expect(joined).toContain(`\nmessage-${TRANSCRIPT_MAX_LINES - 1}\n`);
  expect(joined).not.toContain("\nmessage-0\n");
});

test("messagesToLines retains a bounded suffix of one giant current message", () => {
  const giant = `oldest sentinel\n${"discarded prefix\n".repeat(100_000)}newest giant tail`;
  const lines = messagesToLines([{ role: "assistant", content: giant }], PLAIN, 40);

  expect(lines.length).toBe(TRANSCRIPT_MAX_LINES);
  expect(lines[0]).toBe("(transcript elided)");
  expect(lines.at(-1)).toBe("newest giant tail");
  expect(lines.join("\n")).not.toContain("oldest sentinel");
});

test("assistant parts share terminal parser state while retaining part styling", () => {
  const styled: ThemeLike = {
    bold: (text) => text,
    fg: (color, text) => color === "dim" ? `<dim>${text}</dim>` : text,
  };
  const lines = messagesToLines([{
    role: "assistant",
    content: [
      { type: "text", text: "visible text\n\u001b]osc secret" },
      { type: "thinking", thinking: "still secret\u0007visible thinking" },
      { type: "text", text: "\u001bXsos secret" },
      { type: "thinking", thinking: "still secret\u001b\\styled thought" },
    ],
  }], styled, 80);

  expect(lines).toContain("visible text");
  expect(lines).toContain("<dim>visible thinking</dim>");
  expect(lines).toContain("<dim>styled thought</dim>");
  expect(lines.join("\n")).not.toContain("secret");
});

test("messagesToLines is defensive on empty input", () => {
  expect(messagesToLines([], PLAIN, 40)).toEqual(["(no transcript yet)"]);
});
