#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as h1 from "./h1client.js";
import { intents } from "./intent-router.js";
import { reportAssistantV2 } from "./h1v2.js";

const server = new McpServer(
  { name: "hackerone", version: "3.1.0" },
  {
    instructions:
      "Report drafts are report intents. Normal intent tool names prefer V2 when configured. " +
      "V1 is a pre-write fallback only when V2 is unconfigured or version:v1 is explicitly selected. " +
      "Never switch versions after writes, failures, or a submission attempt; keep the same workflow and draft id. " +
      "create_report_intent creates a NEW draft on every call. To edit or revise an existing draft, " +
      "use update_report_intent with its id and the replacement fields supported by the selected version. " +
      "For attachments: create once, upload_intent_attachments to that id, then update_report_intent on the same id " +
      "using only the returned attachment reference exactly as returned for that intent; re-uploading files produces new ids. " +
      "If update verification fails, inspect the draft and assistant feedback before retrying; do not create a replacement draft. " +
      "Review the processed draft before submitting. Submission requires explicit user approval. " +
      "If V1 submission requires manual severity, the public intent API has no documented field to set it. " +
      "Inspect the existing draft in the HackerOne UI; do not switch versions, recreate, or directly submit it as a workaround. " +
      "Configure optional H1_V2_* HuntProxy web-session settings after logging in, then check " +
      "get_report_assistant_v2_status. V2 uses HTTP only after login; explicit *_v2 tools always use V2, not public REST fallback. " +
      "Create an empty private draft with create_report_intent_v2, then update that same id. Use only returned attachment " +
      "references for that same intent; never reuse references from different draft ids. Review before explicit approval " +
      "and pass the reviewed updated_at to submit_report_intent_v2. Final V2 submission is not live verified.",
  }
);

// The SDK types the callback's args from the schema shape, which TypeScript
// cannot resolve through a generic wrapper. Args are validated by the schema
// at runtime regardless, so bind one concrete signature here.
// registerTool is the current API; server.tool() is deprecated in SDK 1.27.
type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};
type RegisterTool = (
  name: string,
  config: { description?: string; inputSchema?: ZodRawShape; annotations?: ToolAnnotations },
  cb: (params: any) => Promise<CallToolResult>
) => void;

const register = server.registerTool.bind(server) as unknown as RegisterTool;

// Annotation presets. Every tool here talks to a remote API, so openWorldHint
// is true throughout; the meaningful distinctions are read vs write, and
// whether a write can be undone.
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const CREATES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const UPDATES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

// Every tool serialises its result the same way and reports failures as
// tool errors rather than throwing out of the server.
function tool(
  name: string,
  description: string,
  schema: ZodRawShape,
  handler: (params: any) => Promise<unknown>,
  annotations: ToolAnnotations = READ_ONLY
): void {
  register(
    name,
    { description, inputSchema: schema, annotations },
    async (params: any): Promise<CallToolResult> => {
      try {
        const result = await handler(params);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          isError: false,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

const severity = z.enum(["none", "low", "medium", "high", "critical"]);
const programHandle = z.string().describe("Program handle (e.g. 'uber', 'github')");

// ══ Reports ═══════════════════════════════════════════════════════
tool(
  "search_reports",
  "Search and list your HackerOne reports. Filter by keyword, program, severity, or state. " +
    "Note: HackerOne's report list endpoint ignores server-side filters, so any filter here " +
    "paginates your full report history and filters locally — slower, but actually correct. " +
    "Each result has program_posted_last, which only compares timestamps: the report is open and " +
    "the program acted after you did, including status changes and boilerplate. It also has " +
    "awaiting_your_reply with awaiting_reason, which say whether the program actually wants " +
    "something from you. Extra request cost: one GET of /hackers/reports/{id} for each " +
    "returned result where program_posted_last is true. With awaiting_reply, that GET happens " +
    "for every matching report where program_posted_last is true, before results are sliced. " +
    "Closed reports and reports where you spoke last cost nothing extra. Timelines are cached " +
    "for 60s, so a get_report call right after is free.",
  {
    query: z.string().optional().describe("Keyword matched against title, vulnerability info, and asset"),
    program: z.string().optional().describe("Program handle to filter by"),
    severity: severity.optional().describe("Filter by severity rating"),
    state: z
      .enum(["new", "triaged", "needs-more-info", "resolved", "not-applicable", "informative", "duplicate", "spam"])
      .optional()
      .describe("Filter by report state"),
    awaiting_reply: z
      .boolean()
      .optional()
      .describe(
        "Only reports where the program wants something from you: state needs-more-info, or, " +
          "since your last activity, a program comment that is not known boilerplate or an " +
          "unanswered needs-more-info request. Status changes (triaged, " +
          "pending-program-review, severity/title/scope edits, bounty decisions) count only when " +
          "their attached message asks something, such as a question or 'please provide/confirm/" +
          "retest'. " +
          "Costs one extra GET per open report where program_posted_last is true."
      ),
    page_size: z.number().min(1).max(100).optional().describe("Results to return (default 25)"),
    page_number: z.number().optional().describe("Page number; only used when no filter or sort is set"),
    sort: z.string().optional().describe("Sort field, e.g. '-created_at' for newest first. Like a filter, this scans your full report history (up to max_pages) before sorting and taking page_size"),
    max_pages: z.number().min(1).max(50).optional().describe("Cap pages scanned when filtering (default 20)"),
  },
  (p) => h1.searchReports(p)
);

tool(
  "get_report",
  "Get a HackerOne report: vulnerability info, impact, severity, CVSS 4.0 vector and metrics, " +
    "bounty, attachments, and program. Optionally include the timeline in the same call — " +
    "activities and conversation come from this same request, so asking for them here costs " +
    "nothing extra. Returns weakness_id as the CWE external_id (e.g. 'cwe-200'), which is NOT " +
    "the numeric id submit_report wants.",
  {
    report_id: z.string().describe("The HackerOne report ID"),
    include: z
      .array(z.enum(["activities", "conversation"]))
      .optional()
      .describe(
        "'conversation' = every message-bearing activity, for reading triage. " +
        "'activities' = the raw timeline including state changes with no message."
      ),
  },
  ({ report_id, include }) => h1.getReportBundle(report_id, include ?? [])
);

tool(
  "analyze_report_patterns",
  "Analyse your recent reports: severity distribution, states, top programs and assets. " +
    "Weakness types require one extra request per report, so they are opt-in.",
  {
    page_size: z.number().min(10).max(100).optional().describe("Reports to analyse (default 100)"),
    include_weaknesses: z
      .boolean()
      .optional()
      .describe("Fetch each report individually to tally CWE types (slow)"),
  },
  (p) => h1.analyzeReportPatterns(p)
);

// ══ Programs ══════════════════════════════════════════════════════
tool(
  "list_programs",
  "List bug bounty programs you have access to, with bounty settings and your own stats for each. " +
    "Auto-paginates over all of them (hundreds), so filter rather than pulling the lot: " +
    "bookmarked_only is the fastest way to get just the programs you follow. " +
    "Policy text is never included here — use get_program_details for that.",
  {
    page_size: z.number().min(1).max(1000).optional().describe("Max to return after filtering"),
    bookmarked_only: z.boolean().optional().describe("Only programs you have bookmarked on HackerOne"),
    submission_state: z
      .enum(["open", "paused", "disabled"])
      .optional()
      .describe("Only programs in this submission state ('open' = accepting reports)"),
    offers_bounties: z.boolean().optional().describe("Only programs that pay bounties"),
    query: z.string().optional().describe("Substring match against handle and name"),
  },
  (p) => h1.listPrograms(p)
);

tool(
  "get_program_details",
  "Get a program's policy, submission state, bounty settings, and your own stats for it " +
    "(reports filed, valid reports, bounty earned). Note the Hacker API exposes no response-time " +
    "or response-efficiency metrics for programs. The policy blob dominates the payload — " +
    "pass include_policy=false when you only need the metadata.",
  {
    program_handle: programHandle,
    include_policy: z
      .boolean()
      .optional()
      .describe("Include the full policy text (default true). False returns just its length."),
  },
  ({ program_handle, include_policy }) =>
    h1.getProgramDetails(program_handle, include_policy !== false)
);

tool(
  "get_program_scope",
  "Get a program's in-scope assets: types, identifiers, bounty eligibility, and severity caps. Auto-paginates.",
  {
    program_handle: programHandle,
    page_size: z.number().min(1).max(1000).optional().describe("Max to return (default: all)"),
  },
  ({ program_handle, page_size }) => h1.getProgramScope(program_handle, page_size)
);

tool(
  "get_scope_changes",
  "List scope assets added or changed since a date — server-side filtered. Use this to spot newly in-scope attack surface.",
  {
    program_handle: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("One handle, or several to sweep in a single call. Omit when using bookmarked_only."),
    bookmarked_only: z
      .boolean()
      .optional()
      .describe("Sweep every program you have bookmarked — the daily recon loop, in one call."),
    since: z.string().describe("ISO-8601 date, e.g. '2026-01-01' or '2026-01-01T00:00:00+00:00'"),
    field: z
      .enum(["updated_at", "created_at"])
      .optional()
      .describe("Compare against last update (default) or original creation"),
  },
  ({ program_handle, since, field, bookmarked_only }) => {
    if (!bookmarked_only && !program_handle) {
      throw new Error("Pass program_handle (one or several) or bookmarked_only=true.");
    }
    return h1.getScopeChanges(program_handle ?? [], since, field, bookmarked_only ?? false);
  }
);

tool(
  "get_program_weaknesses",
  "Get the weakness/CWE types a program accepts. Auto-paginates. Use the returned id as weakness_id when drafting.",
  {
    program_handle: programHandle,
    page_size: z.number().min(1).max(1000).optional(),
  },
  ({ program_handle, page_size }) => h1.getProgramWeaknesses(program_handle, page_size)
);

tool(
  "get_scope_exclusions",
  "Get report categories a program excludes from rewards, beyond the standard ineligible findings. Check before investing time in a finding.",
  { program_handle: programHandle },
  ({ program_handle }) => h1.getScopeExclusions(program_handle)
);

// ══ Hacktivity ════════════════════════════════════════════════════
tool(
  "search_disclosed_reports",
  "Search publicly disclosed reports (hacktivity) using HackerOne's Lucene query engine. " +
    "Useful for prior art, seeing what a program pays for, and calibrating severity.",
  {
    program: z.string().optional().describe("Program handle, e.g. 'stripe'"),
    query: z
      .string()
      .optional()
      .describe("Free text, or raw Lucene (e.g. 'SSRF AND cve_ids:CVE-2024-1234')"),
    severity: severity.optional().describe("Filter by severity rating"),
    substate: z
      .enum(["resolved", "informative", "duplicate", "not-applicable", "spam"])
      .optional()
      .describe("Filter by final report state"),
    reporter: z.string().optional().describe("Filter by reporter username"),
    min_bounty: z.number().optional().describe("Only reports awarding more than this amount"),
    disclosed_only: z
      .boolean()
      .optional()
      .describe(
        "Default true. Undisclosed hacktivity rows have null title/severity/CWE/bounty " +
        "and no public URL, so they are useless as prior art. Set false only to survey raw activity."
      ),
    sort: z
      .enum([
        "-latest_disclosable_activity_at",
        "latest_disclosable_activity_at",
        "-disclosed_at",
        "disclosed_at",
        "-total_awarded_amount",
        "total_awarded_amount",
        "-votes",
        "votes",
      ])
      .optional()
      .describe("Sort order; '-' prefix is descending"),
    page_size: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe("Results per page (default 25). HackerOne hard-caps this at 50."),
    page_number: z
      .number()
      .min(1)
      .optional()
      .describe("1-based page. Hacktivity returns no pagination links, so page through with this."),
  },
  (p) => h1.searchDisclosedReports(p)
);

// ══ Validation ════════════════════════════════════════════════════
tool(
  "validate_report",
  "Check a report you have drafted against the program's live scope, accepted weaknesses, and reward " +
    "exclusions before filing it. Stateless — pass the fields you plan to submit; nothing is stored or sent. " +
    "Reports blocking errors separately from advisory warnings.",
  {
    program_handle: programHandle,
    title: z.string().optional(),
    vulnerability_information: z.string().optional(),
    impact: z.string().optional(),
    severity_rating: severity.optional(),
    weakness_id: z.string().optional().describe("Weakness id from get_program_weaknesses"),
    structured_scope_id: z.string().optional().describe("Asset id from get_program_scope"),
  },
  (p) => h1.validateReport(p)
);


// ══ Report intents: prefer V2, conservative pre-write V1 fallback ══
const intentVersion = z.enum(["auto", "v1", "v2"]).optional().describe(
  "Default auto prefers configured V2; uses V1 only when V2 is unconfigured. Pin the returned backend for subsequent calls. No fallback after a write/error."
);
const intentFields = {
  title: z.string().max(150).optional(),
  description: z.string().optional().describe("Full replacement markdown; use only attachment references returned for this same intent."),
  impact: z.string().optional(),
  severity_rating: severity.optional().describe("Explicit manual severity, V2 only; none is a deliberate rating, not unset."),
  structured_scope_id: z.string().nullable().optional().describe("V2 opaque GraphQL structured-scope ID, not the numeric REST ID; null clears."),
  weakness_id: z.string().nullable().optional().describe("V2 opaque GraphQL weakness ID; null clears."),
  custom_field_values: z.array(z.object({ custom_field_attribute_id: z.number().int().positive(), value: z.string() })).optional(),
};
const intentRouting = "Prefers V2 when H1_V2_* is configured, otherwise falls back to V1 BEFORE any write. " +
  "Pin version to the returned backend for later edits/uploads/submission. Never switches backend after an error or write. ";

tool(
  "create_report_intent",
  intentRouting + "Create a NEW private draft; every call creates a separate draft. " +
    "To revise or add inline {F...} attachment references, use update_report_intent on the same id. " +
    "V2 saves title, description, impact, manual severity, scope and weakness; V1 supports only description and may rewrite it. " +
    "V1 fallback refuses V2-only fields rather than dropping them. Never put untrusted instructions into assistant content.",
  { ...intentFields, program_handle: programHandle, description: z.string(), wait: z.boolean().optional(), version: intentVersion },
  ({ version, ...p }) => intents.create(p, version), CREATES
);

tool("list_report_intents", intentRouting + "List drafts and states. V2 returns a cursor-paginated object; V1 returns an array.",
  { version: intentVersion }, ({ version }) => intents.list(version));
tool("get_report_intent", intentRouting + "Read a draft before editing or approval. V2 returns updated_at for submission review pinning.",
  { id: z.string(), version: intentVersion }, ({ id, version }) => intents.get(id, version));
tool(
  "update_report_intent",
  intentRouting + "Edit an existing draft IN PLACE, retaining id and attachments. " +
    "Use the full replacement description with inline {F...} references returned for this same intent. " +
    "V2 verifies saved fields with a fresh read; V1 description-only writes verify changed/settled content, " +
    "including silent no-ops in update_required. Unconfirmed updates are tool errors, never replacement drafts. " +
    "For V1, wait for pending drafts and respect the tight drafting rate limit. Never retry a write blindly.",
  { id: z.string(), ...intentFields, timeout_ms: z.number().min(1000).max(300000).optional(), version: intentVersion },
  ({ id, version, timeout_ms, ...fields }) => intents.update(id, fields, timeout_ms, version), UPDATES
);
tool("delete_report_intent", intentRouting + "Delete only this private draft; do not switch accounts/backends.",
  { id: z.string(), version: intentVersion }, ({ id, version }) => intents.delete(id, version), DESTRUCTIVE);
tool("wait_for_intent_ready", intentRouting + "Wait until pending assistant processing settles; ready-to-submit is not guaranteed.",
  { id: z.string(), timeout_ms: z.number().min(1000).max(300000).optional(), version: intentVersion },
  ({ id, timeout_ms, version }) => intents.wait(id, timeout_ms, version));
tool(
  "submit_report_intent",
  intentRouting + "IRREVERSIBLE: requires confirm=true ONLY after explicit user approval of this exact draft. " +
    "V2 also requires expected_updated_at from the reviewed draft and ready_to_submit state. " +
    "The V2 submission operation is derived from shipped code; a live final submission has not been tested. " +
    "No fallback/retry after submission errors. V1 may be blocked by its missing manual-severity selector.",
  { id: z.string(), confirm: z.boolean().describe("True only after explicit approval of this exact submission."),
    expected_updated_at: z.string().min(1).optional().describe("Required for V2: updated_at from the draft the user reviewed."), version: intentVersion },
  ({ id, confirm, expected_updated_at, version }) => intents.submit(id, confirm, expected_updated_at, version), DESTRUCTIVE
);
tool("list_intent_attachments", intentRouting + "List attachment ids and inline references for this same draft only.",
  { id: z.string(), version: intentVersion }, ({ id, version }) => intents.attachments(id, version));
tool("upload_intent_attachments", intentRouting +
  "Upload local screenshot/PoC files to an EXISTING draft. Returns inline {F...} references; " +
  "insert them into the full replacement description with update_report_intent on the SAME id and version. " +
  "Never create a replacement draft or reuse another intent's references. Credential paths are blocked; 25MB total per call.",
  { id: z.string(), file_paths: z.array(z.string()).min(1).max(16), version: intentVersion },
  ({ id, file_paths, version }) => intents.upload(id, file_paths, version), CREATES);
tool("delete_intent_attachment", intentRouting + "Remove one attachment belonging to this draft.",
  { id: z.string(), attachment_id: z.string(), version: intentVersion },
  ({ id, attachment_id, version }) => intents.removeAttachment(id, attachment_id, version), DESTRUCTIVE);

// ══ Optional Report Assistant V2 (web-session path) ═══════════════
const v2Context =
  "Optional V2 path: requires H1_V2_* HuntProxy web-session configuration; HTTP-only after login. " +
  "Never silently switch from public REST. ";
const v2IntentId = z.string().regex(/^[1-9]\d*$/).describe("Positive numeric report intent id (not a GraphQL id)");

tool(
  "get_report_assistant_v2_status",
  v2Context + "Check optional V2 configuration/status before choosing this separate workflow.",
  {},
  () => reportAssistantV2().status()
);

tool(
  "search_report_programs_v2",
  v2Context + "Search programs available to Report Assistant V2.",
  { search: z.string().describe("Program search text") },
  ({ search }) => reportAssistantV2().programs(search)
);

tool(
  "list_report_intents_v2",
  v2Context + "List private V2 report drafts with optional search and pagination.",
  {
    search: z.string().optional().describe("Draft search text"),
    after: z.string().optional().describe("Opaque pagination cursor returned by a previous list"),
  },
  ({ search, after }) => reportAssistantV2().list(search, after)
);

tool(
  "get_report_intent_v2",
  v2Context + "Read and review a V2 draft, including updated_at for optimistic concurrency at submission. " +
    "Use attachment references only as returned for this same intent; never reuse different draft ids.",
  { id: v2IntentId },
  ({ id }) => reportAssistantV2().get(id)
);

tool(
  "create_report_intent_v2",
  v2Context + "Create a NEW empty private draft for a program. Accepts only program_handle; " +
    "then use update_report_intent_v2 on the returned id. Every create makes a separate draft; " +
    "never create a replacement to revise an existing draft or reuse attachment references from different draft ids.",
  { program_handle: programHandle },
  ({ program_handle }) => reportAssistantV2().create(program_handle),
  CREATES
);

tool(
  "update_report_intent_v2",
  v2Context + "Update an existing private draft in place; supply at least one update field. " +
    "Combine edits because repeated saves can queue assistant processing. Review the result before submitting. " +
    "For inline attachments use only the returned reference for this same intent, never references from different draft ids. " +
    "Scope and weakness ids are opaque GraphQL ids, not public REST numeric ids.",
  {
    id: v2IntentId,
    title: z.string().max(150).optional(),
    description: z.string().optional().describe("Replacement vulnerability description in markdown"),
    impact: z.string().optional(),
    severity_rating: severity.optional(),
    structured_scope_id: z.string().nullable().optional().describe("Opaque GraphQL scope id; null clears it"),
    weakness_id: z.string().nullable().optional().describe("Opaque GraphQL weakness id; null clears it"),
    custom_field_values: z.array(z.object({
      custom_field_attribute_id: z.number().int().positive(),
      value: z.string(),
    })).optional(),
  },
  ({ id, ...fields }) => reportAssistantV2().update(id, fields),
  UPDATES
);

tool(
  "upload_intent_attachments_v2",
  v2Context + "Upload local files to an existing V2 draft. Use only each returned reference exactly as returned " +
    "in update_report_intent_v2 on the SAME intent id. Never reuse references from different draft ids; " +
    "re-uploading may create new attachments.",
  {
    id: v2IntentId,
    file_paths: z.array(z.string()).min(1).max(16).describe("Absolute local file paths to upload (1–16)"),
  },
  ({ id, file_paths }) => reportAssistantV2().upload(id, file_paths),
  CREATES
);

tool(
  "delete_intent_attachment_v2",
  v2Context + "Remove an attachment from this V2 draft only. Never substitute a different draft id; " +
    "remove stale inline references from the same draft description as needed.",
  {
    id: v2IntentId,
    attachment_id: z.string().regex(/^[1-9]\d*$/).describe("Positive numeric attachment id from this intent"),
  },
  ({ id, attachment_id }) => reportAssistantV2().removeAttachment(id, attachment_id),
  DESTRUCTIVE
);

tool(
  "submit_report_intent_v2",
  v2Context + "IRREVERSIBLY submit the reviewed V2 draft. Final submission is not live verified. " +
    "Requires explicit user approval of this exact submission before confirm=true; never infer approval from a schema. " +
    "Pass expected_updated_at from the reviewed draft for optimistic concurrency; if it changed, review again " +
    "and obtain fresh approval rather than silently retrying or switching to public REST.",
  {
    id: v2IntentId,
    confirm: z.boolean().describe("True only after explicit user approval of this exact irreversible submission"),
    expected_updated_at: z.string().min(1).describe("Exact updated_at from the draft the user reviewed and approved"),
  },
  ({ id, confirm, expected_updated_at }) => reportAssistantV2().submit(id, confirm, expected_updated_at),
  DESTRUCTIVE
);

// ══ Direct writes ═════════════════════════════════════════════════
tool(
  "submit_report",
  "Submit a report to HackerOne directly, bypassing the draft workflow. IRREVERSIBLE. " +
    "Run validate_report first to catch out-of-scope assets and unaccepted weaknesses. " +
    "Most programs require severity_rating ('none' counts; omitting it does not) and answer 422 without it. " +
    "TRADE-OFF: this path can set severity, weakness and scope but CANNOT carry attachments. " +
    "Prefer the configured V2 intent path when attachments and manual severity are both needed. " +
    "The V1 public intent path supports attachments but cannot set severity, weakness or scope. " +
    "Requires confirm=true, which you may only pass after explicit user approval.",
  {
    program_handle: programHandle,
    title: z.string().describe("Report title"),
    vulnerability_information: z.string().describe("Full details in markdown"),
    impact: z.string().describe("What an attacker achieves (required by HackerOne)"),
    severity_rating: severity.optional(),
    weakness_id: z
      .string()
      .optional()
      .describe(
        "NUMERIC weakness id from get_program_weaknesses. Not the CWE external_id " +
        "that get_report returns (e.g. 'cwe-200') — that is a different identifier and is rejected."
      ),
    structured_scope_id: z
      .string()
      .optional()
      .describe("Numeric asset id from get_program_scope"),
    confirm: z
      .boolean()
      .describe(
        "Must be true. Files a real, irreversible report against a real program. " +
        "Set this ONLY when the user has approved this specific submission in their own words — " +
        "never merely because the schema requires the field."
      ),
  },
  ({ confirm, ...opts }) => {
    if (!confirm) {
      throw new Error(
        `submit_report files a real report to '${opts.program_handle}' and cannot be undone. ` +
          `Re-run with confirm=true once the user has explicitly approved it.`
      );
    }
    return h1.submitReport(opts);
  },
  DESTRUCTIVE
);

// ══ Account ═══════════════════════════════════════════════════════
tool(
  "get_earnings",
  "Your bounty earnings: amount, bonus, currency, paying program, and the report each award came from.",
  {
    page_size: z.number().min(1).max(100).optional(),
    page_number: z.number().min(1).optional().describe("1-based page, for history beyond the first 100"),
  },
  ({ page_size, page_number }) => h1.getEarnings(page_size, page_number)
);

tool(
  "get_payouts",
  "Your payout transactions: amount, provider, reference, and status.",
  {
    page_size: z.number().min(1).max(100).optional(),
    page_number: z.number().min(1).optional().describe("1-based page, for history beyond the first 100"),
  },
  ({ page_size, page_number }) => h1.getPayouts(page_size, page_number)
);

tool("get_balance", "Your current unpaid bounty balance.", {}, () => h1.getBalance());

tool(
  "get_hacker_profile",
  "Your hacker profile: username, reputation, signal, and account info.",
  {},
  () => h1.getHackerProfile()
);

// ══ Start ═════════════════════════════════════════════════════════
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HackerOne MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
