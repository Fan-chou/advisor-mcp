import assert from "node:assert/strict";
import test from "node:test";
import { AdviceParseError, formatAdvice, parseAdviceResponse } from "../src/advice.js";

test("parses plain and fenced advisor JSON", () => {
  const advice = parseAdviceResponse(
    "```json\n" +
      JSON.stringify({
        verdict: "adjust",
        summary: "Drain the queue before canceling workers.",
        guidance: ["Close input first"],
        risks: ["In-flight jobs can be lost"],
        next_actions: ["Add a shutdown test"],
        evidence_gaps: [],
        confidence: "high",
      }) +
      "\n```",
    { sessionId: "s1", model: "test-model" },
  );

  assert.equal(advice.verdict, "adjust");
  assert.equal(advice.confidence, "high");
  assert.deepEqual(advice.guidance, ["Close input first"]);
  assert.match(advice.consultId, /^[0-9a-f-]{36}$/);
});

test("normalizes optional arrays and confidence", () => {
  const advice = parseAdviceResponse(
    JSON.stringify({ verdict: "proceed", summary: "Go ahead." }),
    { sessionId: "s1", model: "test-model" },
  );
  assert.deepEqual(advice.risks, []);
  assert.equal(advice.confidence, "medium");
});

test("rejects invalid verdicts and non-JSON", () => {
  assert.throws(
    () => parseAdviceResponse('{"verdict":"maybe","summary":"x"}', { sessionId: "s", model: "m" }),
    AdviceParseError,
  );
  assert.throws(
    () => parseAdviceResponse("not json", { sessionId: "s", model: "m" }),
    AdviceParseError,
  );
});

test("formats advice for an MCP text result", () => {
  const advice = parseAdviceResponse(
    JSON.stringify({
      verdict: "stop",
      summary: "Stop before migrating.",
      guidance: ["Back up first"],
      risks: [],
      next_actions: [],
      evidence_gaps: ["Migration script not supplied"],
      confidence: "low",
    }),
    { sessionId: "s1", model: "m1" },
  );
  const text = formatAdvice(advice);
  assert.match(text, /Advisor verdict: stop/);
  assert.match(text, /Migration script not supplied/);
  assert.match(text, /advisor_model: m1/);
});
