// Update verification tests use a mocked HackerOne API; no live drafts are touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pathToFileURL } from "node:url";

test("report intent updates are confirmed by bounded read-after-write checks", async () => {
  const oldUsername = process.env.H1_USERNAME;
  const oldToken = process.env.H1_API_TOKEN;
  const oldFetch = globalThis.fetch;
  const oldNow = Date.now;
  const oldSetTimeout = globalThis.setTimeout;
  let fakeNow = oldNow();

  process.env.H1_USERNAME = "test-user";
  process.env.H1_API_TOKEN = "test-token";

  // Advance time through polling sleeps and between scenarios. This keeps the
  // module's local report-intent write limiter from affecting the mock cases.
  Date.now = () => fakeNow;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    fakeNow += Number(delay) || 0;
    queueMicrotask(() => callback(...args));
    return 1;
  };

  const scenarios = new Map();
  const writes = [];
  const jsonResponse = (data) => new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const payload = (id, snapshot) => ({
    id,
    type: "report-intent",
    attributes: {
      title: `Draft ${id}`,
      description: snapshot.description,
      state: snapshot.state,
    },
    relationships: { attachments: { data: [] } },
  });

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    const match = url.pathname.match(/^\/v1\/hackers\/report_intents\/(\d+)$/);
    if (!match) throw new Error(`Unexpected mocked HackerOne request: ${method} ${url.pathname}`);

    const id = match[1];
    const scenario = scenarios.get(id);
    if (!scenario) throw new Error(`Missing update test scenario for intent ${id}`);

    if (method === "PATCH") {
      writes.push({ method, id });
      scenario.requested = JSON.parse(options.body).data.attributes.description;
      scenario.afterPatch = true;
      return jsonResponse({ data: payload(id, scenario.current) });
    }
    if (method === "GET") {
      if (scenario.afterPatch && scenario.reads.length > 0) {
        scenario.current = scenario.reads.shift();
      }
      return jsonResponse({ data: payload(id, scenario.current) });
    }
    throw new Error(`Unexpected mocked HackerOne request: ${method} ${url.pathname}`);
  };

  try {
    const h1 = await import(pathToFileURL(`${process.cwd()}/dist/h1client.js`));
    let nextId = 910000;
    const setup = (state, description, reads = []) => {
      const id = String(nextId++);
      scenarios.set(id, {
        current: { state, description },
        reads: [...reads],
        afterPatch: false,
        requested: null,
      });
      return id;
    };
    const onlyPatchFor = (id) => writes.filter((write) => write.id === id);
    const advanceLimiterWindow = () => { fakeNow += 11 * 60_000; };

    // Exact replacement persists verbatim.
    {
      const id = setup("ready_to_submit", "old text", [
        { state: "ready_to_submit", description: "new text" },
      ]);
      const result = await h1.updateReportIntent(id, "new text", 5_000);
      assert.equal(result.id, id);
      assert.equal(result.description, "new text");
      assert.equal(result.update_status, "description_changed");
      assert.equal(result.description_matches_request, true);
      assert.equal(result.timed_out, false);
      assert.deepEqual(onlyPatchFor(id).map((write) => write.method), ["PATCH"]);
    }

    advanceLimiterWindow();
    // HackerOne may rewrite a valid update; the changed description is the
    // observable evidence used by the client, and the response reports rewriting.
    {
      const id = setup("ready_to_submit", "old text", [
        { state: "ready_to_submit", description: "assistant formatted text" },
      ]);
      const result = await h1.updateReportIntent(id, "requested text", 5_000);
      assert.equal(result.description, "assistant formatted text");
      assert.equal(result.update_status, "description_changed");
      assert.equal(result.description_matches_request, false);
      assert.equal(onlyPatchFor(id).length, 1);
    }

    advanceLimiterWindow();
    // A nonpending stale read must continue polling; a pending read is also
    // tolerated before the assistant finishes and publishes the description.
    {
      const id = setup("update_required", "old text", [
        { state: "update_required", description: "old text" },
        { state: "pending", description: "old text" },
        { state: "ready_to_submit", description: "updated after processing" },
      ]);
      const result = await h1.updateReportIntent(id, "requested revision", 10_000);
      assert.equal(result.description, "updated after processing");
      assert.equal(result.update_status, "description_changed");
      assert.equal(result.description_matches_request, false);
      assert.equal(onlyPatchFor(id).length, 1);
    }

    advanceLimiterWindow();
    // Silent no-op in update_required must not look successful.
    {
      const id = setup("update_required", "original", [
        { state: "update_required", description: "original" },
      ]);
      await assert.rejects(
        h1.updateReportIntent(id, "revision", 1_000),
        (error) => /not confirmed/i.test(error.message) &&
          error.message.includes(id) && /get_report_intent|HackerOne UI/i.test(error.message) &&
          /unchanged/i.test(error.message) && /update_required/i.test(error.message)
      );
      assert.equal(onlyPatchFor(id).length, 1);
    }

    advanceLimiterWindow();
    // The same silent no-op is detected on a settled state.
    {
      const id = setup("ready_to_submit", "original", [
        { state: "ready_to_submit", description: "original" },
      ]);
      await assert.rejects(
        h1.updateReportIntent(id, "revision", 1_000),
        (error) => /not confirmed/i.test(error.message) && error.message.includes(id)
      );
      assert.equal(onlyPatchFor(id).length, 1);
    }

    advanceLimiterWindow();
    // A changed body is still unconfirmed if the assistant remains pending at
    // the deadline; the result must not imply that processing completed.
    {
      const id = setup("ready_to_submit", "original", [
        { state: "pending", description: "new but still processing" },
      ]);
      await assert.rejects(
        h1.updateReportIntent(id, "revision", 1_000),
        (error) => /not confirmed/i.test(error.message) && error.message.includes(id)
      );
      assert.equal(onlyPatchFor(id).length, 1);
    }

    advanceLimiterWindow();
    // An already-current description avoids an unnecessary assistant job.
    {
      const id = setup("ready_to_submit", "same text");
      const result = await h1.updateReportIntent(id, "same text", 5_000);
      assert.equal(result.update_status, "already_current");
      assert.equal(result.description_matches_request, true);
      assert.deepEqual(onlyPatchFor(id), []);
    }

    advanceLimiterWindow();
    // A draft already being processed cannot safely accept a revision.
    {
      const id = setup("pending", "old text");
      await assert.rejects(
        h1.updateReportIntent(id, "revision", 5_000),
        (error) => /pending/i.test(error.message) && /wait_for_intent_ready/i.test(error.message)
      );
      assert.deepEqual(onlyPatchFor(id), []);
    }

    advanceLimiterWindow();
    // update_required is not blanket-blocked: a changed read verifies success.
    {
      const id = setup("update_required", "old text", [
        { state: "update_required", description: "new text" },
      ]);
      const result = await h1.updateReportIntent(id, "new text", 5_000);
      assert.equal(result.update_status, "description_changed");
      assert.equal(result.state, "update_required");
      assert.equal(onlyPatchFor(id).length, 1);
    }
  } finally {
    if (oldUsername === undefined) delete process.env.H1_USERNAME;
    else process.env.H1_USERNAME = oldUsername;
    if (oldToken === undefined) delete process.env.H1_API_TOKEN;
    else process.env.H1_API_TOKEN = oldToken;
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
    globalThis.setTimeout = oldSetTimeout;
  }
});

test("MCP exposes an unconfirmed update_required no-op as a tool error", async () => {
  const entry = pathToFileURL(`${process.cwd()}/dist/index.js`).href;
  const bootstrap = [
    `const target = ${JSON.stringify(entry)};`,
    `globalThis.fetch = async (input, options = {}) => {`,
    `  const url = new URL(input);`,
    `  const method = options.method ?? "GET";`,
    `  if (url.pathname !== "/v1/hackers/report_intents/912345") {`,
    `    throw new Error("Unexpected mock request: " + method + " " + url.pathname);`,
    `  }`,
    `  const data = { id: "912345", type: "report-intent", attributes: { title: "Draft", description: "original description", state: "update_required" }, relationships: { attachments: { data: [] } } };`,
    `  if (method === "PATCH") return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });`,
    `  if (method === "GET") return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });`,
    `  throw new Error("Unexpected mock method: " + method);`,
    `};`,
    `await import(target);`,
  ].join("\n");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "-e", bootstrap],
    cwd: process.cwd(),
    env: { ...process.env, H1_USERNAME: "test-user", H1_API_TOKEN: "test-token" },
    stderr: "pipe",
  });
  const client = new Client({ name: "report-intent-update-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const updateTool = tools.tools.find((tool) => tool.name === "update_report_intent");
    assert.ok(updateTool, "update_report_intent is registered");
    assert.equal(updateTool.inputSchema.properties.timeout_ms.type, "number");
    assert.equal(updateTool.inputSchema.properties.timeout_ms.minimum, 1000);
    assert.equal(updateTool.inputSchema.required.includes("timeout_ms"), false);

    const result = await client.callTool({
      name: "update_report_intent",
      arguments: { id: "912345", description: "revised description", timeout_ms: 1000 },
    });
    assert.equal(result.isError, true);
    const message = result.content.map((item) => item.text ?? "").join("\n");
    assert.match(message, /912345/);
    assert.match(message, /update_required/);
    assert.match(message, /not confirmed/i);
  } finally {
    await client.close();
  }
});
