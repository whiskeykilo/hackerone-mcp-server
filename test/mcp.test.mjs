import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("stdio server initializes and exposes valid tool schemas after dependency updates", async () => {
  const client = new Client({ name: "maintenance-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    // No credentials: this test must never perform a live HackerOne request.
    env: { PATH: process.env.PATH ?? "" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, version);
    const { tools } = await client.listTools();
    assert.ok(tools.length > 20);
    const submitIntent = tools.find((t) => t.name === "submit_report_intent");
    assert.ok(submitIntent);
    assert.equal(submitIntent.annotations.destructiveHint, true);
    assert.equal(submitIntent.inputSchema.properties.confirm.type, "boolean");
    assert.ok(submitIntent.inputSchema.required.includes("confirm"));
    assert.deepEqual(submitIntent.inputSchema.properties.version.enum, ["auto", "v1", "v2"]);
    const submitV2 = tools.find((t) => t.name === "submit_report_intent_v2");
    assert.ok(submitV2.inputSchema.required.includes("expected_updated_at"));
    assert.equal(submitV2.annotations.destructiveHint, true);
    const updateIntent = tools.find((t) => t.name === "update_report_intent");
    assert.ok(updateIntent.inputSchema.properties.severity_rating);
    assert.equal(updateIntent.inputSchema.required.includes("description"), false);
    const submit = tools.find((t) => t.name === "submit_report");
    assert.deepEqual(submit.inputSchema.properties.severity_rating.enum, ["none", "low", "medium", "high", "critical"]);
    // A destructive call missing confirmation must fail validation before dispatch.
    const result = await client.callTool({ name: "submit_report_intent", arguments: { id: "123" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /confirm/);
    assert.doesNotMatch(JSON.stringify(result.content), /Missing H1_USERNAME/);
  } finally {
    await client.close();
  }
});
