// Runs against compiled output: `npm test` builds first. All HackerOne calls
// are intercepted by fetch below; these tests never contact the live API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("report intents can be revised in place with references to their attachments", async () => {
  const oldUsername = process.env.H1_USERNAME;
  const oldToken = process.env.H1_API_TOKEN;
  const oldFetch = globalThis.fetch;
  const tempDir = await mkdtemp(join(tmpdir(), "h1-intent-test-"));
  const filePath = join(tempDir, "proof.txt");
  await writeFile(filePath, "synthetic proof artifact\n");

  process.env.H1_USERNAME = "test-user";
  process.env.H1_API_TOKEN = "test-token";

  const calls = [];
  const intents = new Map();
  const attachmentsByIntent = new Map();
  let nextIntentId = 400707;
  let nextAttachmentId = 8100;

  const intentData = (id, state = "ready_to_submit") => {
    const intent = intents.get(id);
    return {
      id,
      type: "report-intent",
      attributes: {
        title: `Draft ${id}`,
        description: intent.description,
        state,
        has_failing_jobs: false,
        has_canceled_jobs: false,
      },
      relationships: {
        attachments: {
          data: (attachmentsByIntent.get(id) ?? []).map((a) => ({
            id: a.id,
            attributes: a.attributes,
          })),
        },
      },
    };
  };

  const jsonResponse = (data) => new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    const path = url.pathname;
    calls.push({ method, path, options });

    if (path === "/v1/hackers/report_intents" && method === "POST") {
      const body = JSON.parse(options.body);
      const id = String(nextIntentId++);
      intents.set(id, { description: body.data.attributes.description });
      attachmentsByIntent.set(id, []);
      return jsonResponse({ data: intentData(id, "pending") });
    }

    const attachmentMatch = path.match(/^\/v1\/hackers\/report_intents\/(\d+)\/attachments$/);
    if (attachmentMatch && method === "POST") {
      const id = attachmentMatch[1];
      const form = options.body;
      assert.ok(form instanceof FormData, "upload uses multipart FormData");
      const uploaded = form.getAll("files[]");
      const rows = uploaded.map((file) => ({
        id: String(nextAttachmentId++),
        type: "attachment",
        attributes: {
          file_name: file.name,
          content_type: file.type || "text/plain",
          file_size: file.size,
          expiring_url: `https://example.invalid/${file.name}`,
        },
      }));
      attachmentsByIntent.set(id, [...(attachmentsByIntent.get(id) ?? []), ...rows]);
      return jsonResponse({ data: rows });
    }

    const attachmentListMatch = path.match(/^\/v1\/hackers\/report_intents\/(\d+)\/attachments$/);
    if (attachmentListMatch && method === "GET") {
      return jsonResponse({ data: attachmentsByIntent.get(attachmentListMatch[1]) ?? [] });
    }

    const intentMatch = path.match(/^\/v1\/hackers\/report_intents\/(\d+)$/);
    if (intentMatch && method === "PATCH") {
      const id = intentMatch[1];
      const body = JSON.parse(options.body);
      assert.equal(body.data.id, id);
      intents.set(id, { description: body.data.attributes.description });
      return jsonResponse({ data: intentData(id) });
    }
    if (intentMatch && method === "GET") {
      return jsonResponse({ data: intentData(intentMatch[1]) });
    }

    throw new Error(`Unexpected mocked HackerOne request: ${method} ${path}`);
  };

  try {
    const h1 = await import(pathToFileURL(join(process.cwd(), "dist/h1client.js")));

    const created = await h1.createReportIntent({
      program_handle: "example-program",
      description: "Initial draft",
    });
    assert.equal(created.id, "400707");
    assert.equal(created.state, "ready_to_submit", "default create waits for processing");
    assert.equal(created.timed_out, false);
    assert.equal(created.next_steps.tool, "update_report_intent");
    assert.equal(created.next_steps.arguments.id, created.id);
    assert.match(created.next_steps.guidance, /update/i);

    const uploaded = await h1.uploadIntentAttachments(created.id, [filePath]);
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].id, "8100");
    assert.equal(uploaded[0].reference, `{F${uploaded[0].id}}`);

    const listed = await h1.listIntentAttachments(created.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, uploaded[0].id);
    assert.equal(listed[0].reference, uploaded[0].reference);

    const revisedDescription = `Revised report\n\nSupporting material: ${uploaded[0].reference}`;
    const updated = await h1.updateReportIntent(created.id, revisedDescription);
    assert.equal(updated.id, created.id);
    assert.equal(updated.description, revisedDescription, "update replaces the full description");
    assert.deepEqual(updated.attachments.map((a) => a.id), [uploaded[0].id]);

    const writes = calls.filter(({ method, path }) =>
      path === "/v1/hackers/report_intents" && method === "POST" ||
      /^\/v1\/hackers\/report_intents\/\d+$/.test(path) && method === "PATCH"
    );
    assert.deepEqual(writes.map(({ method, path }) => [method, path]), [
      ["POST", "/v1/hackers/report_intents"],
      ["PATCH", `/v1/hackers/report_intents/${created.id}`],
    ]);

    const noWait = await h1.createReportIntent({
      program_handle: "example-program",
      description: "Draft without polling",
      wait: false,
    });
    assert.equal(noWait.id, "400708");
    assert.equal(noWait.state, "pending", "mock create response is returned directly");
    assert.equal(noWait.next_steps.tool, "update_report_intent");
    assert.equal(noWait.next_steps.arguments.id, noWait.id);
    assert.match(noWait.next_steps.guidance, /update/i);
    assert.equal(
      calls.filter(({ method, path }) => method === "GET" && path === `/v1/hackers/report_intents/${noWait.id}`).length,
      0,
      "wait=false does not poll after creating the draft"
    );
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUsername === undefined) delete process.env.H1_USERNAME;
    else process.env.H1_USERNAME = oldUsername;
    if (oldToken === undefined) delete process.env.H1_API_TOKEN;
    else process.env.H1_API_TOKEN = oldToken;
    await rm(tempDir, { recursive: true, force: true });
  }
});
