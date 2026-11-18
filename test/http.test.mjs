import { test } from "node:test";
import assert from "node:assert/strict";

// Fresh module state for each case; no live HackerOne requests.
let moduleId = 0;
async function withTransport(run) {
  const oldFetch = globalThis.fetch;
  const oldUsername = process.env.H1_USERNAME;
  const oldToken = process.env.H1_API_TOKEN;
  process.env.H1_USERNAME = "test-user";
  process.env.H1_API_TOKEN = "test-token";
  try {
    const http = await import(`../dist/http.js?case=${moduleId++}`);
    await run(http);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUsername === undefined) delete process.env.H1_USERNAME;
    else process.env.H1_USERNAME = oldUsername;
    if (oldToken === undefined) delete process.env.H1_API_TOKEN;
    else process.env.H1_API_TOKEN = oldToken;
  }
}
const json = (data) => new Response(JSON.stringify(data), {
  headers: { "content-type": "application/json" },
});

test("manual severity intent errors explain the V1 limitation without suggesting guessed fields", () => withTransport(async ({ h1Request, H1ApiError }) => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ errors: [{ detail: "Select a manual severity rating before submitting this report." }] }), { status: 422 });
  };
  await assert.rejects(h1Request("/hackers/report_intents/123/submit", { method: "POST", body: {} }), (error) => {
    assert.ok(error instanceof H1ApiError);
    assert.equal(error.status, 422);
    assert.match(error.message, /V1/);
    assert.match(error.message, /V2/);
    assert.match(error.message, /no documented.*severity/i);
    assert.match(error.message, /not retried/i);
    return true;
  });
  assert.equal(calls, 1);
}));

test("unrelated validation errors retain generic field guidance", () => withTransport(async ({ H1ApiError }) => {
  const error = new H1ApiError(422, "Title is missing", "POST", "/hackers/reports");
  assert.match(error.message, /required field/);
  assert.doesNotMatch(error.message, /V1/);
}));

test("pagination URLs cannot send credentials outside the HackerOne API", () => withTransport(async ({ h1Request }) => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({}); };
  for (const url of ["https://example.invalid/v1/hackers/reports", "http://api.hackerone.com/v1/hackers/reports", "https://api.hackerone.com/outside", "https://user:pass@api.hackerone.com/v1/hackers/reports"]) {
    await assert.rejects(h1Request("/hackers/reports", { url }), /HackerOne API URL/);
  }
  assert.equal(calls, 0);
}));

test("requests refuse redirects and use a timeout signal", () => withTransport(async ({ h1Request }) => {
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return json({ data: [] });
  };
  await h1Request("/hackers/reports");
}));

test("pagination stops at the cap without fetching an unused page", () => withTransport(async ({ h1FetchAll }) => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json({ data: [{ id: String(calls) }], links: { next: "https://api.hackerone.com/v1/hackers/reports?page[number]=2" } });
  };
  assert.deepEqual(await h1FetchAll("/hackers/reports", undefined, 1), {
    rows: [{ id: "1" }], truncated: true, pages: 1,
  });
  assert.equal(calls, 1);
  await assert.rejects(h1FetchAll("/hackers/reports", undefined, 0), /maxPages/);
  assert.equal(calls, 1);
}));

test("pagination collects all pages when the cap is not reached", () => withTransport(async ({ h1FetchAll }) => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json({ data: [{ id: String(calls) }], links: calls === 1
      ? { next: "https://api.hackerone.com/v1/hackers/reports?page[number]=2" } : {} });
  };
  assert.deepEqual(await h1FetchAll("/hackers/reports", undefined, 3), {
    rows: [{ id: "1" }, { id: "2" }], truncated: false, pages: 2,
  });
  assert.equal(calls, 2);
}));

test("credential changes do not reuse cached account data", () => withTransport(async ({ h1Request }) => {
  let calls = 0;
  globalThis.fetch = async () => json({ account: ++calls });
  assert.equal((await h1Request("/hackers/me/reports")).account, 1);
  assert.equal((await h1Request("/hackers/me/reports")).account, 1);
  process.env.H1_API_TOKEN = "different-token";
  assert.equal((await h1Request("/hackers/me/reports")).account, 2);
  delete process.env.H1_API_TOKEN;
  await assert.rejects(h1Request("/hackers/me/reports"), /Missing H1_USERNAME/);
}));

test("an in-flight response from old credentials cannot repopulate the cache", () => withTransport(async ({ h1Request }) => {
  let resolveOld;
  const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
  let started;
  const oldStarted = new Promise((resolve) => { started = resolve; });
  globalThis.fetch = async (_url, options) => {
    if (options.headers.Authorization === `Basic ${Buffer.from("test-user:test-token").toString("base64")}`) {
      started();
      return oldResponse;
    }
    return json({ account: "new" });
  };
  const oldRequest = h1Request("/hackers/me/reports");
  await oldStarted;
  process.env.H1_API_TOKEN = "different-token";
  assert.equal((await h1Request("/hackers/me/reports")).account, "new");
  resolveOld(json({ account: "old" }));
  assert.equal((await oldRequest).account, "old");
  assert.equal((await h1Request("/hackers/me/reports")).account, "new");
}));

test("network failures never retry POST submissions", () => withTransport(async ({ h1Request }) => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("connection lost"); };
  await assert.rejects(h1Request("/hackers/report_intents/123/submit", { method: "POST", body: {} }), /may already.*processed/s);
  assert.equal(calls, 1);
}));
