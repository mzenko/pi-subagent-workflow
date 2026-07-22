import { expect, test } from "bun:test";
import { BoundedTail, sanitizeTerminalText, sanitizeTerminalTextChunks } from "../src/ui/sanitize.js";

test("BoundedTail retains insertion order before reaching capacity", () => {
  const tail = new BoundedTail<number>(3);
  tail.push(1);
  tail.push(2);

  expect(tail.values()).toEqual([1, 2]);
  expect(tail.elided).toBe(false);
});

test("BoundedTail wraps repeatedly while retaining the newest values in order", () => {
  const tail = new BoundedTail<string>(3);
  for (const value of ["a", "b", "c", "d", "e"]) tail.push(value);

  expect(tail.values()).toEqual(["c", "d", "e"]);
  expect(tail.elided).toBe(true);
});

test("BoundedTail with zero capacity elides every pushed value", () => {
  const tail = new BoundedTail<number>(0);
  tail.push(1);

  expect(tail.values()).toEqual([]);
  expect(tail.elided).toBe(true);
});

test("sanitizeTerminalText strips control bytes and terminal escape sequences", () => {
  const input = [
    "safe",
    "\u0000",
    "\u001b[2J",
    "middle",
    "\u001b]0;window title\u0007",
    "\u001bPdevice command\u001b\\",
    "\u001b_private message\u001b\\",
    "\u009b31m",
    "text",
    "\u0085",
    "\tend",
  ].join("");

  expect(sanitizeTerminalText(input)).toBe("safemiddletext\tend");
});

test("sanitizeTerminalText strips bidi formatting controls", () => {
  const input = [
    "safe",
    "\u061c",
    "\u200e",
    "\u200f",
    "\u202aembedded\u202c",
    "\u202doverridden\u202c",
    "\u202ereversed\u202c",
    "\u2066isolated\u2069",
    "\u2067rtl isolated\u2069",
    "\u2068first strong\u2069",
    "end",
  ].join("");

  expect(sanitizeTerminalText(input)).toBe("safeembeddedoverriddenreversedisolatedrtl isolatedfirst strongend");
});

test("sanitizeTerminalText preserves ordinary printable text and bounds its output", () => {
  expect(sanitizeTerminalText("plain café 🙂", 8)).toBe("plain ca");
});

test("sanitizeTerminalText suppresses SOS and PM in 7-bit and C1 forms", () => {
  const input = [
    "start",
    "\u001bXsos secret\u0007still secret\u001b\\after sos",
    "\u0098c1 sos secret\u009cafter c1 sos",
    "\u001b^pm secret\u0007still secret\u001b\\after pm",
    "\u009ec1 pm secret\u009cafter c1 pm",
  ].join("");

  expect(sanitizeTerminalText(input)).toBe("startafter sosafter c1 sosafter pmafter c1 pm");
});

test("sanitizeTerminalTextChunks preserves control parser state at chunk boundaries", () => {
  const chunks = [
    "safe\u001b",
    "]osc secret\u001b",
    "\\after osc\u001bP",
    "dcs secret\u001b",
    "\\after dcs\u001b",
    "Xsos secret\u001b",
    "\\after sos\u009e",
    "pm secret\u009cafter pm\u009b31",
    "mstyled",
  ];

  expect(sanitizeTerminalTextChunks(chunks)).toBe("safeafter oscafter dcsafter sosafter pmstyled");
});
