import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { markTuiSession, reportDiagnostic } from "../src/diagnostics.js";

const logPath = join(process.env.PI_CODING_AGENT_DIR!, "subagent-workflow", "diagnostics.log");
const rotatedPath = `${logPath}.1`;

beforeAll(() => {
  rmSync(logPath, { force: true });
  rmSync(rotatedPath, { force: true });
});

afterAll(() => {
  rmSync(logPath, { force: true });
  rmSync(rotatedPath, { force: true });
});

test("diagnostics default to sanitized stderr and route to a file after a TUI session is marked", () => {
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    reportDiagnostic("default \x1b[31mred\x1b[0m\x07");
    expect(errorLog).toHaveBeenCalledWith("default red");
    expect(() => readFileSync(logPath, "utf8")).toThrow();

    markTuiSession();
    reportDiagnostic("file route");
    expect(readFileSync(logPath, "utf8")).toContain("file route");
    expect(errorLog).toHaveBeenCalledTimes(1);
  } finally {
    errorLog.mockRestore();
  }
});

test("diagnostic log lines strip terminal control bytes", () => {
  rmSync(logPath, { force: true });
  reportDiagnostic("safe\x1b]0;hostile-title\x07 text\x00 end");

  const logged = readFileSync(logPath, "utf8");
  expect(logged).toContain("safe text end");
  expect(logged).not.toContain("hostile-title");
  expect(logged).not.toContain("\x1b");
  expect(logged).not.toContain("\x00");
});

test("a permissive file crossing the diagnostics cap rotates with both files restricted", () => {
  rmSync(logPath, { force: true });
  rmSync(rotatedPath, { force: true });
  mkdirSync(dirname(logPath), { recursive: true });
  const old = "x".repeat(5 * 1024 * 1024);
  writeFileSync(logPath, old);
  chmodSync(logPath, 0o644);

  reportDiagnostic("new incident");

  expect(readFileSync(rotatedPath, "utf8")).toBe(old);
  expect(statSync(rotatedPath).mode & 0o777).toBe(0o600);
  const current = readFileSync(logPath, "utf8");
  expect(current).toContain("new incident");
  expect(current).not.toContain(old);
  expect(statSync(logPath).mode & 0o777).toBe(0o600);
});

test("diagnostics enforce mode 0600 on a pre-existing file", () => {
  writeFileSync(logPath, "old incident\n");
  chmodSync(logPath, 0o666);

  reportDiagnostic("next incident");

  expect(statSync(logPath).mode & 0o777).toBe(0o600);
});
