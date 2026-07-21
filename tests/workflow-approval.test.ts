import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveLaunch, buildApprovalSummary, type ApprovalContext, type ExtensionMode, type LaunchOrigin, type LaunchPlan } from "../src/workflow/approval.js";
import { ConsentStore } from "../src/workflow/consent.js";
import { hashScript } from "../src/workflow/journal.js";
import type { WorkflowMeta } from "../src/types.js";
import { parseWorkflowScript } from "../src/workflow/parser.js";

const META: WorkflowMeta = { name: "audit-routes", description: "Audit routes", phases: [{ title: "Discover" }, { title: "Audit" }] };

function consent(): ConsentStore {
  return new ConsentStore(join(mkdtempSync(join(tmpdir(), "approval-")), "consent.json"));
}

interface Recorder {
  ctx: ApprovalContext;
  selects: string[];
  editorOpened: number;
  scriptViewed: number;
}

function recorder(mode: ExtensionMode, choices: Array<string | undefined>): Recorder {
  const queue = [...choices];
  const rec: Recorder = { selects: [], editorOpened: 0, scriptViewed: 0, ctx: undefined as never };
  rec.ctx = {
    mode,
    cwd: "/work",
    ui: {
      select: async (title: string) => {
        rec.selects.push(title);
        return queue.shift();
      },
      editor: async () => {
        rec.editorOpened += 1;
        return undefined;
      },
      custom: async () => {
        rec.scriptViewed += 1;
        return undefined as never;
      },
      notify: () => {},
    },
  };
  return rec;
}

function plan(origin: LaunchOrigin, body = "await agent('a'); await agent('b');", meta: WorkflowMeta = META): LaunchPlan {
  const script = `export const meta = ${JSON.stringify(meta)};\n${body}`;
  return { workflow: parseWorkflowScript(script), args: null, origin };
}

test("approval summary lists name and phases", () => {
  const summary = buildApprovalSummary(plan("saved"));
  expect(summary).toContain("Launch workflow: audit-routes");
  expect(summary).toContain("Phases: Discover -> Audit");
  expect(summary).not.toContain("Agent calls");
  expect(summary).not.toContain("Budget");
});

test("approval summary strips terminal controls from workflow metadata", () => {
  const unsafe = plan("saved", "return 1", {
    name: "audit-routes",
    description: "safe\u001b[2Jdescription",
    phases: [{ title: "phase\u0007" }],
  });
  const summary = buildApprovalSummary(unsafe);
  expect(summary).toContain("safedescription");
  expect(summary).toContain("phase");
  expect(summary).not.toContain("\u001b");
  expect(summary).not.toContain("\u0007");
});

test("non-tui modes auto-approve without prompting", async () => {
  for (const mode of ["json", "print", "rpc"] as ExtensionMode[]) {
    const rec = recorder(mode, []);
    await approveLaunch(plan("inline"), rec.ctx, { consent: consent() });
    expect(rec.selects).toHaveLength(0);
  }
});

test("Run once approves without recording consent", async () => {
  const store = consent();
  const rec = recorder("tui", ["Run once"]);
  await approveLaunch(plan("saved"), rec.ctx, { consent: store });
  expect(rec.selects).toHaveLength(1);
  expect(store.isApproved("audit-routes", "/work", hashScript(plan("saved").workflow.script))).toBe(false);
});

test("Always records consent and later saved runs skip the dialog", async () => {
  const store = consent();
  const first = recorder("tui", ["Always for this workflow in this project"]);
  const approvedPlan = plan("saved");
  await approveLaunch(approvedPlan, first.ctx, { consent: store });
  expect(store.isApproved("audit-routes", "/work", hashScript(approvedPlan.workflow.script))).toBe(true);

  const second = recorder("tui", []);
  await approveLaunch(plan("saved"), second.ctx, { consent: store });
  expect(second.selects).toHaveLength(0);
});

test("always-prompt ignores remembered consent and never offers Always", async () => {
  const store = consent();
  const saved = plan("saved");
  store.record(saved.workflow.meta.name, "/work", hashScript(saved.workflow.script));
  const rec = recorder("tui", ["Run once"]);

  await approveLaunch(saved, rec.ctx, { consent: store, policy: "always-prompt" });

  expect(rec.selects).toHaveLength(1);
  expect(rec.selects[0]).not.toContain("Always");
});

test("always-prompt refuses a forged Always selection without recording consent", async () => {
  const store = consent();
  const saved = plan("saved");

  await expect(approveLaunch(saved, recorder("tui", ["Always for this workflow in this project"]).ctx, {
    consent: store,
    policy: "always-prompt",
  })).rejects.toThrow("denied");

  expect(store.isApproved(saved.workflow.meta.name, "/work", hashScript(saved.workflow.script))).toBe(false);
});

test("auto policy bypasses the TUI dialog", async () => {
  const rec = recorder("tui", []);
  await approveLaunch(plan("inline"), rec.ctx, { consent: consent(), policy: "auto" });
  expect(rec.selects).toHaveLength(0);
});

test("invalid approval policy fails with context", async () => {
  await expect(approveLaunch(plan("saved"), recorder("tui", []).ctx, {
    consent: consent(),
    policy: "invalid" as never,
  })).rejects.toThrow("Invalid workflow approval policy: invalid");
});

test("editing a saved workflow invalidates Always consent", async () => {
  const store = consent();
  const approved = plan("saved", "return agent('original')");
  await approveLaunch(approved, recorder("tui", ["Always for this workflow in this project"]).ctx, { consent: store });

  const changed = plan("saved", "return agent('replacement')");
  const rec = recorder("tui", ["Run once"]);
  await approveLaunch(changed, rec.ctx, { consent: store });
  expect(rec.selects).toHaveLength(1);
});

test("inline scripts never skip even when a same-named workflow was approved", async () => {
  const store = consent();
  store.record("audit-routes", "/work", hashScript(plan("inline").workflow.script));
  const rec = recorder("tui", ["Run once"]);
  await approveLaunch(plan("inline"), rec.ctx, { consent: store });
  expect(rec.selects).toHaveLength(1);
  // Inline dialogs do not offer the Always option.
  expect(rec.selects[0]).not.toContain("Always");
});

test("View script and Open in editor loop back to the dialog", async () => {
  const rec = recorder("tui", ["View script", "Open in editor", "Run once"]);
  await approveLaunch(plan("saved"), rec.ctx, { consent: consent() });
  expect(rec.scriptViewed).toBe(1);
  expect(rec.editorOpened).toBe(1);
  expect(rec.selects).toHaveLength(3);
});

test("Deny and dialog dismissal throw a relayable error", async () => {
  await expect(approveLaunch(plan("saved"), recorder("tui", ["Deny"]).ctx, { consent: consent() })).rejects.toThrow("denied");
  await expect(approveLaunch(plan("saved"), recorder("tui", [undefined]).ctx, { consent: consent() })).rejects.toThrow("denied");
});
