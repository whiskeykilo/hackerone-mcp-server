import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readAttachmentFiles } from "./attachments.js";
import type { Severity } from "./h1client.js";

const ENDPOINT = "https://hackerone.com/graphql";
const ATTACHMENT_FIELDS = "id _id file_name file_size content_type";
const INTENT_FIELDS = `id _id agent_version title description impact state updated_at custom_fields
  team { id handle name } severity { rating calculation_method }
  structured_scope { id asset_identifier } weakness { id name external_id }
  attachments { ${ATTACHMENT_FIELDS} } report { id _id }`;
const ERROR_FIELDS = "errors { edges { node { message } } }";

export type HuntProxyCall = (name: string, args: Record<string, unknown>) => Promise<any>;
export interface V2Config {
  projectId: number;
  exchangeId: number;
  username: string;
  command?: string;
  dataDir?: string;
}
export interface V2Update {
  title?: string;
  description?: string;
  impact?: string;
  severity_rating?: Severity;
  structured_scope_id?: string | null;
  weakness_id?: string | null;
  custom_field_values?: { custom_field_attribute_id: number; value: string }[];
}

function numericId(id: string): number {
  if (!/^[1-9]\d*$/.test(id) || Number(id) > 2_147_483_647) {
    throw new Error("Expected a positive numeric report-intent ID (GraphQL Int).");
  }
  return Number(id);
}
function intentGid(id: string): string {
  numericId(id);
  return Buffer.from(`gid://hackerone/ReportIntent/${id}`).toString("base64");
}
function messages(errors: any): string {
  return (errors?.edges ?? []).map((e: any) => e?.node?.message).filter(Boolean).join("; ");
}
function attachment(a: any) {
  return {
    id: String(a._id), graphql_id: a.id, reference: `{F${a._id}}`,
    file_name: a.file_name, file_size: a.file_size, content_type: a.content_type,
  };
}
function intent(r: any) {
  return {
    id: String(r._id), graphql_id: r.id, agent_version: r.agent_version,
    title: r.title, description: r.description, impact: r.impact, state: r.state,
    updated_at: r.updated_at, program: r.team, severity: r.severity,
    structured_scope: r.structured_scope, weakness: r.weakness, custom_fields: r.custom_fields,
    attachments: (r.attachments ?? []).map(attachment),
    report_id: r.report?._id == null ? null : String(r.report._id),
    url: `https://hackerone.com/hai/report_assistant/${r._id}?v2=1`,
  };
}

/** HTTP-only web-session client. Never starts or controls a browser. */
export class ReportAssistantV2 {
  private call: HuntProxyCall;
  constructor(private config: V2Config, call?: HuntProxyCall) {
    if (![config.projectId, config.exchangeId].every((n) => Number.isSafeInteger(n) && n > 0) || !config.username.trim()) {
      throw new Error("V2 requires a positive HuntProxy project ID, authentication exchange ID, and expected username.");
    }
    this.call = call ?? huntProxyCaller(config);
  }

  private async validateBase(): Promise<void> {
    const metadata = await this.call("exchange_get", {
      project_id: this.config.projectId, exchange_id: this.config.exchangeId, body_bytes: 0,
    });
    const base = (metadata.exchanges ?? [metadata]).find((e: any) => e.exchange_id === this.config.exchangeId);
    if (!base || base.url !== ENDPOINT || base.method !== "POST") {
      throw new Error("V2 authentication exchange must be a captured POST to https://hackerone.com/graphql in the configured project.");
    }
  }

  private async send(body: Record<string, unknown> | Buffer, boundary?: string, write = false): Promise<any> {
    let response;
    try {
      response = await this.call("reply_send", {
        project_id: this.config.projectId, base_exchange_id: this.config.exchangeId,
        // Keep the captured CSRF/session headers inside HuntProxy. Never reveal them.
        draft: {
          url: ENDPOINT, method: "POST", inheritance: "full_request",
          header_tombstones: ["content-length", "content-type", "host"],
          ...(Buffer.isBuffer(body)
            ? { body_override: Array.from(body), header_overrides: [{ name: "Content-Type", value: `multipart/form-data; boundary=${boundary}` }] }
            : { body_json: body }),
        },
      });
    } catch {
      throw new Error(write
        ? "V2 write failed or timed out. It was not retried and may already have succeeded. Inspect the draft/report state before retrying."
        : "HuntProxy HTTP request failed. Check the configured project, authentication exchange, and session.");
    }
    if (response.effective_url !== ENDPOINT) throw new Error("V2 refused an unexpected HTTP response destination.");
    if (response.status_code !== 200) {
      throw new Error(`V2 HTTP ${response.status_code}. Refresh the test/account session through HuntProxy if expired or challenged. No retry was attempted.`);
    }
    let text = response.response_preview?.text;
    if (response.response_preview?.truncated) {
      const bodyResult = await this.call("exchange_body", {
        project_id: this.config.projectId, exchange_id: response.exchange_id,
        side: "response", max_bytes: 1_048_576,
      });
      if (bodyResult.truncated || bodyResult.available === false) {
        throw new Error("V2 response is incomplete; inspect server-side state before retrying. No retry was attempted.");
      }
      text = bodyResult.preview;
    }
    let result;
    try { result = JSON.parse(text); }
    catch { throw new Error("V2 returned a non-JSON response (possibly a login/Cloudflare page). Inspect state before retrying; no retry was attempted."); }
    if (result.errors?.length) {
      throw new Error(`V2 GraphQL error: ${result.errors.map((e: any) => e.message).join("; ")}. No retry was attempted.`);
    }
    if (!result.data) throw new Error("V2 returned no GraphQL data. Inspect state before retrying.");
    return result.data;
  }

  private query(query: string, variables: Record<string, unknown> = {}, write = false) {
    return this.send({ query, variables }, undefined, write);
  }

  async status() {
    await this.validateBase();
    const data = await this.query("query H1V2Identity { me { id username } }");
    if (data.me?.username !== this.config.username) {
      throw new Error("V2 account mismatch or expired session. No write was sent; check H1_V2_USERNAME and the authentication exchange.");
    }
    return { enabled: true, username: data.me.username, project_id: this.config.projectId, browser_required: false };
  }

  async programs(search: string) {
    await this.status();
    const data = await this.query(`query H1V2Programs($search: String) {
      me { teams_that_i_can_submit_reports_to(search: $search, first: 50) {
        edges { node { id handle name } } pageInfo { hasNextPage endCursor }
      } }
    }`, { search });
    const connection = data.me.teams_that_i_can_submit_reports_to;
    return { results: connection.edges.map((e: any) => e.node), truncated: connection.pageInfo.hasNextPage };
  }

  async list(search?: string, after?: string) {
    await this.status();
    const data = await this.query(`query H1V2History($search: String, $after: String) {
      me { report_intents(search: $search, after: $after, first: 25) {
        edges { node { id _id agent_version title state updated_at team { handle name } } }
        pageInfo { hasNextPage endCursor }
      } }
    }`, { search: search ?? null, after: after ?? null });
    const connection = data.me.report_intents;
    return {
      results: connection.edges.map((e: any) => intent(e.node)),
      has_next_page: connection.pageInfo.hasNextPage, end_cursor: connection.pageInfo.endCursor,
    };
  }

  private async read(id: string) {
    const data = await this.query(`query H1V2Intent($id: Int!) { report_intent(id: $id) { ${INTENT_FIELDS} } }`, { id: numericId(id) });
    if (!data.report_intent) throw new Error(`Report intent ${id} was not found or is inaccessible.`);
    return data.report_intent;
  }

  async get(id: string) {
    numericId(id);
    await this.status();
    return intent(await this.read(id));
  }

  private async editable(id: string) {
    const r = await this.read(id);
    if (r.agent_version !== 2) throw new Error("This tool edits only V2 intents; no V1 intent was migrated or changed.");
    if (r.report || r.state === "submitted") throw new Error("This intent has already been submitted. No write was sent.");
    // V2 keeps unchecked drafts in "pending" while the UI still permits edits
    // and uploads. Unlike V1, pending alone does not prove an assistant job is active.
    return r;
  }

  async create(programHandle: string) {
    const found = await this.programs(programHandle);
    const program = found.results.find((p: any) => p.handle === programHandle);
    if (!program) throw new Error("No exact submittable program match in the returned page. Check the handle and program eligibility.");
    const data = await this.query(`mutation CreateReportIntentV2($input: CreateReportIntentV2Input!) {
      createReportIntentV2(input: $input) { was_successful report_intent { id _id } ${ERROR_FIELDS} }
    }`, { input: { team_id: program.id } }, true);
    const result = data.createReportIntentV2;
    if (!result?.was_successful || !result.report_intent?._id) throw new Error(`V2 draft creation unconfirmed: ${messages(result?.errors) || "no draft ID returned"}. Check history before retrying.`);
    const id = String(result.report_intent._id);
    return { id, url: `https://hackerone.com/hai/report_assistant/${id}?v2=1`, next_step: "update_report_intent_v2", submitted: false };
  }

  async update(id: string, fields: V2Update) {
    numericId(id);
    const input: Record<string, unknown> = { report_intent_id: intentGid(id) };
    for (const key of ["title", "description", "impact", "structured_scope_id", "weakness_id", "custom_field_values"] as const) {
      if (fields[key] !== undefined) input[key] = fields[key];
    }
    if (fields.severity_rating !== undefined) {
      if (!["none", "low", "medium", "high", "critical"].includes(fields.severity_rating)) throw new Error("Invalid manual severity rating.");
      input.severity_hash = { calculation_method: "manual", type: "manual", rating: fields.severity_rating };
    }
    if (Object.keys(input).length === 1) throw new Error("Provide at least one field to update.");
    await this.status();
    const current = await this.editable(id);
    const available = new Set(current.attachments.map((a: any) => String(a._id)));
    for (const text of [fields.description, fields.impact]) {
      for (const match of text?.matchAll(/\{F(\d+)\}/g) ?? []) {
        if (!available.has(match[1])) throw new Error(`Attachment reference {F${match[1]}} does not belong to this draft. No write was sent.`);
      }
    }
    const data = await this.query(`mutation SaveReportIntent($input: SaveReportIntentInput!) {
      saveReportIntent(input: $input) { was_successful report_intent { ${INTENT_FIELDS} } ${ERROR_FIELDS} }
    }`, { input }, true);
    const result = data.saveReportIntent;
    if (!result?.was_successful) throw new Error(`V2 save failed: ${messages(result?.errors) || "not confirmed"}`);
    const saved = await this.read(id);
    for (const key of ["title", "description", "impact"] as const) {
      if (fields[key] !== undefined && saved[key] !== fields[key]) throw new Error(`V2 ${key} save did not verify. Review the draft; no retry was attempted.`);
    }
    if (fields.severity_rating !== undefined && (saved.severity?.rating !== fields.severity_rating || saved.severity?.calculation_method !== "manual")) {
      throw new Error("V2 manual severity save did not verify. Review the draft; no retry was attempted.");
    }
    for (const [key, relationship] of [["structured_scope_id", "structured_scope"], ["weakness_id", "weakness"]] as const) {
      if (fields[key] !== undefined && (saved[relationship]?.id ?? null) !== fields[key]) throw new Error(`V2 ${key} save did not verify. Review the draft; no retry was attempted.`);
    }
    if (fields.custom_field_values !== undefined && !fields.custom_field_values.every((f) =>
      (saved.custom_fields ?? []).some((s: any) => Number(s.custom_field_attribute_id) === f.custom_field_attribute_id && s.value === f.value))) {
      throw new Error("V2 custom-field save did not verify. Review the draft; no retry was attempted.");
    }
    return { ...intent(saved), update_verified: true };
  }

  async upload(id: string, paths: string[]) {
    numericId(id);
    const files = await readAttachmentFiles(paths);
    await this.status();
    await this.editable(id);
    const operations = {
      query: `mutation UploadReportIntentAttachments($input: UploadReportIntentAttachmentsInput!) {
        uploadReportIntentAttachments(input: $input) { was_successful attachments { ${ATTACHMENT_FIELDS} } ${ERROR_FIELDS} }
      }`,
      variables: { input: { report_intent_id: intentGid(id), files: files.map(() => null) } },
    };
    const map = Object.fromEntries(files.map((_, i) => [String(i + 1), [`variables.input.files.${i}`]]));
    const form = new FormData();
    form.append("operations", JSON.stringify(operations));
    form.append("map", JSON.stringify(map));
    for (const [i, file] of files.entries()) form.append(String(i + 1), new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.name);
    const encoded = new Response(form);
    const boundary = encoded.headers.get("content-type")!.split("boundary=")[1];
    const data = await this.send(Buffer.from(await encoded.arrayBuffer()), boundary, true);
    const result = data.uploadReportIntentAttachments;
    if (!result?.was_successful || result.attachments?.length !== files.length) throw new Error(`V2 upload unconfirmed: ${messages(result?.errors) || "attachment count mismatch"}. Check attachments before retrying.`);
    const saved = await this.read(id);
    if (!result.attachments.every((a: any) => saved.attachments.some((s: any) => s.id === a.id))) throw new Error("V2 upload response was successful but attachments did not verify on the draft. Check before retrying.");
    return result.attachments.map(attachment);
  }

  async removeAttachment(id: string, attachmentId: string) {
    numericId(id);
    if (!/^[1-9]\d*$/.test(attachmentId)) throw new Error("Expected a numeric attachment ID.");
    await this.status();
    const current = await this.editable(id);
    const selected = current.attachments.find((a: any) => String(a._id) === attachmentId);
    if (!selected) throw new Error("Attachment is not on this draft. No write was sent.");
    const data = await this.query(`mutation DeleteReportIntentAttachmentsV2($input: DeleteReportIntentAttachmentsInput!) {
      deleteReportIntentAttachments(input: $input) { was_successful report_intent { id attachments { id } } }
    }`, { input: { report_intent_id: intentGid(id), attachment_ids: [selected.id] } }, true);
    if (!data.deleteReportIntentAttachments?.was_successful) throw new Error("V2 attachment deletion was not confirmed. Inspect before retrying.");
    if ((await this.read(id)).attachments.some((a: any) => a.id === selected.id)) throw new Error("V2 attachment deletion did not verify. Inspect before retrying.");
    return { deleted: true, intent_id: id, attachment_id: attachmentId };
  }

  async delete(id: string) {
    numericId(id);
    await this.status();
    await this.editable(id);
    const data = await this.query(`mutation DeleteReportIntent($input: DeleteReportIntentMutationInput!) {
      deleteReportIntent(input: $input) { was_successful ${ERROR_FIELDS} }
    }`, { input: { report_intent_id: intentGid(id) } }, true);
    if (!data.deleteReportIntent?.was_successful) throw new Error(`V2 draft deletion was not confirmed: ${messages(data.deleteReportIntent?.errors)}. Inspect before retrying.`);
    return { deleted: true, id };
  }

  async submit(id: string, confirm: boolean, expectedUpdatedAt: string) {
    numericId(id);
    if (!confirm) throw new Error("V2 submission requires confirm=true only after explicit approval of this exact draft. No request was sent.");
    if (!expectedUpdatedAt) throw new Error("Supply expected_updated_at from the draft the user reviewed.");
    await this.status();
    const current = await this.editable(id);
    if (current.updated_at !== expectedUpdatedAt) throw new Error("Draft changed since review. Re-read it and obtain fresh approval. No submission was sent.");
    if (current.state !== "ready_to_submit") throw new Error("Draft is not ready_to_submit. Review required checks/eligibility in HackerOne; no submission was sent.");
    const data = await this.query(`mutation SubmitReportIntentV2Mutation($input: SubmitReportIntentInput!) {
      submitReportIntent(input: $input) { was_successful report_intent { id _id report { id _id } } ${ERROR_FIELDS} }
    }`, { input: { report_intent_id: intentGid(id) } }, true);
    const result = data.submitReportIntent;
    const reportId = result?.report_intent?.report?._id;
    if (!result?.was_successful || !reportId) throw new Error(`V2 submission not confirmed: ${messages(result?.errors) || "no report ID returned"}. It may have succeeded. Check report history before retrying; no retry was attempted.`);
    return { intent_id: id, report_id: String(reportId), url: `https://hackerone.com/reports/${reportId}` };
  }
}

function huntProxyCaller(config: V2Config): HuntProxyCall {
  let connection: Promise<Client> | undefined;
  return async (name, args) => {
    connection ??= (async () => {
      const client = new Client({ name: "hackerone-v2-http", version: "3.1.0" });
      // Do not pass the public API credentials to the child process.
      const env: Record<string, string> = { HUNTPROXY_MCP_DISABLE_LIFECYCLE: "1" };
      for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"]) {
        if (process.env[key]) env[key] = process.env[key]!;
      }
      const dataDir = config.dataDir ?? process.env.HUNTPROXY_DATA_DIR;
      if (dataDir) env.HUNTPROXY_DATA_DIR = dataDir;
      const transport = new StdioClientTransport({ command: config.command ?? "HuntProxy", args: ["mcp"], env, stderr: "ignore" });
      try { await client.connect(transport); }
      catch (error) { await transport.close(); throw error; }
      return client;
    })();
    let client: Client;
    try { client = await connection; }
    catch { connection = undefined; throw new Error("Unable to connect to HuntProxy. Check the executable and data directory."); }
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }) as CallToolResult;
    if (result.isError) throw new Error(`HuntProxy ${name} failed. Inspect its project state before retrying.`);
    if (result.structuredContent) return result.structuredContent;
    const text = result.content.find((c) => c.type === "text");
    if (!text || text.type !== "text") throw new Error("HuntProxy returned no structured result.");
    return JSON.parse(text.text);
  };
}

let configured: ReportAssistantV2 | undefined;
export function reportAssistantV2(): ReportAssistantV2 {
  if (!configured) {
    const { H1_V2_HUNTPROXY_PROJECT_ID: project, H1_V2_HUNTPROXY_EXCHANGE_ID: exchange, H1_V2_USERNAME: username } = process.env;
    if (!project || !exchange || !username) throw new Error("V2 is optional. Set H1_V2_HUNTPROXY_PROJECT_ID, H1_V2_HUNTPROXY_EXCHANGE_ID, and H1_V2_USERNAME for a dedicated authenticated HuntProxy project. Public API tools remain independent.");
    configured = new ReportAssistantV2({ projectId: Number(project), exchangeId: Number(exchange), username, command: process.env.H1_V2_HUNTPROXY_COMMAND, dataDir: process.env.H1_V2_HUNTPROXY_DATA_DIR });
  }
  return configured;
}
