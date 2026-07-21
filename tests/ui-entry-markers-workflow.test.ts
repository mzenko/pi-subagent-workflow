import { describe, expect, test } from "bun:test";
import { PLAIN } from "../src/ui/format.js";
import { renderRunCompleted, renderRunStarted } from "../src/ui/entry-markers.js";

describe("workflow-shaped run markers", () => {
  test("run-started without labels renders the workflow form with phases", () => {
    const lines = renderRunStarted(
      { runId: "workflow-1", runDir: "/tmp/x", phases: [{ title: "Discover" }, { title: "Audit" }] },
      PLAIN,
      120,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("workflow run workflow-1 started: Discover → Audit");
  });

  test("run-completed without perChild renders the compact workflow form", () => {
    const lines = renderRunCompleted({ runId: "workflow-1", runDir: "/tmp/x" }, PLAIN, 120);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("workflow workflow-1");
  });
});
