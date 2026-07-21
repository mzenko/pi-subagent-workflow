import { expect, test } from "bun:test";
import { createReportResultTool } from "../src/runner/schema-tool.js";

test("schema tool preserves raw JSON Schema and captures arguments", async () => {
  const schema = { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false };
  const capture: { called: boolean; value?: unknown } = { called: false };
  const tool = createReportResultTool(schema, capture);
  expect(tool.parameters).toEqual(schema);
  await tool.execute("call", { answer: 42 }, undefined, undefined, {} as never);
  expect(capture).toEqual({ called: true, value: { answer: 42 } });
});

test("the first report_result call wins and duplicate calls are tool errors", async () => {
  const capture: { called: boolean; value?: unknown; terminate?: () => void } = { called: false };
  let terminations = 0;
  capture.terminate = () => { terminations += 1; };
  const tool = createReportResultTool({ type: "object" }, capture);

  await tool.execute("first", { answer: 1 }, undefined, undefined, {} as never);
  await expect(tool.execute("second", { answer: 2 }, undefined, undefined, {} as never))
    .rejects.toThrow("report_result may only be called once");

  expect(capture.value).toEqual({ answer: 1 });
  expect(terminations).toBe(1);
});
