import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PLAIN, type ThemeLike } from "../src/ui/format.js";
import { UNTRUSTED_FIELD_MAX } from "../src/ui/sanitize.js";
import {
  messagesToLines,
  readSessionMessages,
  SESSION_ENTRY_MAX_BYTES,
  sessionEntriesToMessages,
  TRANSCRIPT_MAX_LINES,
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

test("readSessionMessages skips an oversized newest record and returns older messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-session-"));
  const path = join(dir, "oversized.jsonl");
  const older = { type: "message", message: { role: "assistant", content: "older survives" } };
  const oversized = { type: "message", message: { role: "toolResult", content: "x".repeat(512 * 1024) } };
  writeFileSync(path, `${JSON.stringify(older)}\n${JSON.stringify(oversized)}\n`);

  expect(readSessionMessages(path)).toEqual([{ role: "assistant", content: "older survives" }]);
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
  expect(messages).toHaveLength(512);
  expect(messages[0]?.content).toBe("recent-88");
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
