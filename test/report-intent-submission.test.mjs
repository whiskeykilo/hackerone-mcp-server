import { test } from "node:test";
import assert from "node:assert/strict";
import { submitReportIntent } from "../dist/h1client.js";

test("intent submission preserves confirmation, report relationship IDs, and ambiguous-success warnings", async () => {
  const oldFetch = globalThis.fetch;
  const oldUsername = process.env.H1_USERNAME;
  const oldToken = process.env.H1_API_TOKEN;
  process.env.H1_USERNAME = "test-user";
  process.env.H1_API_TOKEN = "test-token";
  const calls = [];
  let reportId = "9001";
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    calls.push({ path: url.pathname, method: options.method });
    assert.equal(url.origin, "https://api.hackerone.com");
    assert.match(url.pathname, /^\/v1\/hackers\/report_intents\/123(?:\/submit)?$/);
    const relationships = reportId ? { report: { data: { id: reportId, type: "report" } } } : {};
    return new Response(JSON.stringify({ data: {
      id: "123", type: "report-intent",
      attributes: { title: "Synthetic test", state: options.method === "GET" ? "ready_to_submit" : "submitted" },
      relationships,
    } }), { headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(submitReportIntent("123", false), /explicitly approved/);
    assert.deepEqual(calls.map((call) => call.method), ["GET"]);
    const submitted = await submitReportIntent("123", true);
    assert.equal(submitted.intent_id, "123");
    assert.equal(submitted.report_id, "9001");
    assert.equal(submitted.url, "https://hackerone.com/reports/9001");
    reportId = null;
    const ambiguous = await submitReportIntent("123", true);
    assert.equal(ambiguous.url, null);
    assert.equal(ambiguous.report_id, null);
    assert.match(ambiguous.warning, /may still have been submitted/);
    assert.equal(calls.filter((call) => call.method === "POST").length, 2, "one POST per explicit call, no retries");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUsername === undefined) delete process.env.H1_USERNAME;
    else process.env.H1_USERNAME = oldUsername;
    if (oldToken === undefined) delete process.env.H1_API_TOKEN;
    else process.env.H1_API_TOKEN = oldToken;
  }
});
