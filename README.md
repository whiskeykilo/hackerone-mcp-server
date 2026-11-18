# HackerOne MCP Server

> **Disclaimer:** This is an unofficial, community-built project. It is not affiliated with, endorsed by, or maintained by HackerOne. "HackerOne" is a trademark of HackerOne, Inc. This project simply integrates with their publicly documented [Hacker API](https://api.hackerone.com/hacker-resources/).

MCP server that gives Claude Code (or any MCP client) full access to your HackerOne reports, programs, earnings, and scope data via the HackerOne API — including submitting reports and responding to triage.

## Setup

### 1. Get your HackerOne API token

Go to **HackerOne > Settings > API Token** and generate one.

### 2. Install and build

Use a maintained Node.js LTS release (Node.js 22 or newer recommended).

```bash
git clone https://github.com/Sicks3c/hackerone-mcp-server.git
cd hackerone-mcp-server
npm install
npm run build
```

### 3. Add to Claude Code

```bash
claude mcp add hackerone \
  -e H1_USERNAME=your-username \
  -e H1_API_TOKEN=your-api-token \
  -s user \
  -- node /path/to/hackerone-mcp-server/dist/index.js
```

Or add manually to `~/.claude.json`:

```json
{
  "mcpServers": {
    "hackerone": {
      "command": "node",
      "args": ["/path/to/hackerone-mcp-server/dist/index.js"],
      "env": {
        "H1_USERNAME": "your-username",
        "H1_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### 4. Verify

```bash
claude
> /mcp
# You should see "hackerone" and its tools listed
```

## Drafting a report

### Preferred: Report Assistant V2 over HTTP

The normal intent tools now **prefer V2 when configured**. V2 can save title,
description, impact, manual severity, asset, weakness, and attachments together.
Routine requests use HuntProxy's HTTP transport, **not browser automation**.
A browser/human handoff may still be needed for initial login, expired sessions,
or Cloudflare challenges. This is an unofficial web GraphQL integration and may
change independently of the documented public API.

Configure the MCP server process with:

```text
H1_V2_HUNTPROXY_PROJECT_ID=<dedicated HuntProxy project ID>
H1_V2_HUNTPROXY_EXCHANGE_ID=<successful authenticated POST /graphql exchange ID>
H1_V2_USERNAME=<expected HackerOne username>
H1_V2_HUNTPROXY_COMMAND=/home/you/.local/bin/HuntProxy
# Optional when using a non-default HuntProxy data directory:
# H1_V2_HUNTPROXY_DATA_DIR=/path/to/private/huntproxy-data
```

Use a dedicated HuntProxy project/profile, log in to the intended account, and
capture an authenticated `POST https://hackerone.com/graphql` request containing
the session/CSRF headers. Only its exchange ID is needed here; do not copy
passwords, MFA seeds, cookies, or CSRF tokens into this repository. The server
keeps credentials inside HuntProxy and checks the logged-in username before
writes. Public REST credentials remain separate and are not passed to HuntProxy.
Check `get_report_assistant_v2_status` after setup.

**Conservative fallback:** `version: "auto"` (default) chooses configured V2;
when V2 is entirely unconfigured, it uses V1 with a warning. Partial/broken V2
configuration, expired sessions, account mismatch, unsupported fields, and write
errors do **not** trigger fallback. V1-only mode is available with
`version: "v1"`; explicit `*_v2` tools always use V2. Pin the returned `backend`
on subsequent calls. Existing V1 drafts are not automatically migrated. Fields
V1 cannot save are rejected rather than silently discarded. Never switch paths
after a failed creation, upload, or submission.

```text
create_report_intent(program_handle, title, description, impact, severity_rating)
  -> upload_intent_attachments(id, version: "v2", file_paths)
  -> update_report_intent(id, version: "v2", description containing returned {F...})
  -> get_report_intent(id, version: "v2")
  -> review and explicit approval
  -> submit_report_intent(id, version: "v2", confirm: true,
                          expected_updated_at: <reviewed updated_at>)
```

Inline screenshots use the returned `reference` (e.g. `{F123456}`) on its own
line in the complete replacement description. Upload **first**, then save the
references on the **same intent**. V2 uploads and saves are verified with fresh
reads, and saves reject inline references that are not attached to that draft.
An unchecked V2 draft may remain `pending` while still accepting edits/uploads;
`wait_for_intent_ready` reports V2 readiness but does not run checks. Final
submission refuses a changed draft or a state other than
`ready_to_submit`; it is never retried automatically. The final submission
operation is based on the shipped V2 client but **has not been live-tested**;
identity verification, program eligibility, and pre-submission checks still apply.

Additional explicit V2 tools: `search_report_programs_v2`,
`list_report_intents_v2`, `get_report_intent_v2`, `create_report_intent_v2`,
`update_report_intent_v2`, `upload_intent_attachments_v2`,
`delete_intent_attachment_v2`, and `submit_report_intent_v2`. `create_report_intent_v2`
creates an empty draft; the normal `create_report_intent` also saves initial content.
For scope/weakness updates, use opaque GraphQL IDs, not numeric REST IDs. V2
history is cursor-paginated; the normal list tool returns its first page and
explicit `list_report_intents_v2` accepts the next cursor.

See [verified V2 protocol findings](docs/report-assistant-v2-investigation.md).

### Public API / V1 compatibility workflow

The following description-only assistant behavior applies to `version: "v1"`.

HackerOne's own draft mechanism is called a **report intent**. Create one, review
what HackerOne makes of it, then submit it as a real report — or delete it.
Nothing is filed until you explicitly approve it.

**Create once; edit with `update_report_intent`.** Every `create_report_intent`
call creates a separate draft. To revise an existing draft, pass its `id` and
the **full replacement description** to `update_report_intent`; it keeps the
same draft and its attachments.

```
create_report_intent → upload_intent_attachments (if needed)
                     → update_report_intent (same id, revised description)
                     → (review) → submit_report_intent(confirm: true)
```

For inline attachment citations, upload files to the created intent first.
`upload_intent_attachments` and `list_intent_attachments` return a `reference`
such as `{F123456}` for each file. Insert those values into the complete
description and update **that same intent id**. Uploading the same files again
produces new attachment ids, so references from another draft must not be
reused. Review the processed description and attachments before submission.

The server includes this workflow in its MCP initialization instructions and
tool descriptions. Create results also include `next_steps` naming the update
tool and the created intent id, so agents can find the edit path even when a
tool search returns only part of the tool list.

`update_report_intent` verifies the write with uncached reads. It saves the
original description, sends one PATCH, and waits for a changed description
with processing no longer `pending`. This catches a reported API edge case:
an `update_required` draft can return HTTP success while retaining the old
text. Stale reads are polled until `timeout_ms` (default 60 seconds); an
unchanged description or unfinished processing then produces a **tool error**,
not a successful update. Review the draft and assistant feedback before
retrying. The server never retries the PATCH or creates a replacement draft.
A draft that is already `pending` must settle before an update is attempted.

Successful responses include `update_status: "description_changed"` and
`description_matches_request`. The latter can be false because the assistant
may rewrite the submitted text; a changed description alone does not prove
that every requested edit survived, so review it. If the requested description
already matches the existing text, the server skips PATCH and returns
`update_status: "already_current"`. A rewrite back to the original text cannot
be distinguished from a no-op and is reported as unconfirmed.

This server does not store drafts for you. Keep working copies wherever you
like and push one to HackerOne when it is ready. The optional V2 path relies on
HuntProxy's private persisted session/traffic store; treat that store as sensitive.

### Manual severity error in Report Assistant V1

If HackerOne says **"Select a manual severity rating before submitting this
report."**, the V1 assistant can be blocked even though it has no severity
selector. The V2 UI has a manual selector; this server cannot add one to V1.

The [published intent API](https://api.hackerone.com/hacker-resources/)
currently documents only `description` for PATCH and no submission body. There
is no documented intent severity field to send. Adding severity text to the
description is not the same as choosing a manual rating, and the server does
not send guessed attributes or automatically recreate the draft.

- Review the existing draft in V2 if available, or use HackerOne's standard
  report form to set severity. Check content, program, and attachments before
  submitting, and check whether a report already exists before switching paths.
- `submit_report` supports `severity_rating` (`none`, `low`, `medium`, `high`,
  `critical`) but **cannot carry attachments**. It creates a separate report,
  not a conversion of the intent. Use it only after reviewing all fields and
  obtaining fresh explicit approval; do not transfer intent attachment
  references to a direct report and assume they will work.
- A matching intent API error now explains this limitation. The failed request
  is not retried and no replacement draft or direct submission is made.

This is a HackerOne-side V1 UI/public-API mismatch. The optional V2 integration
above can save manual severity using the verified web GraphQL operation; it does
not add severity support to the public REST intent endpoint or migrate V1 drafts.

Other intent behavior previously verified against the live API:

- **You cannot set the title.** HackerOne's assistant generates it, and rejects
  the attribute with a 400 if you try.
- **`description` is the only documented editable field.** This server cannot
  set severity, weakness or scope on an intent. Do not assume HackerOne will
  automatically supply a valid manual severity at submission time.
- **Writes are asynchronous.** Creating or updating an intent queues an
  assistant job on HackerOne's side. The API responds *before* that job runs, so
  the response is already stale. `create_report_intent` and
  `update_report_intent` wait for it to settle; `wait_for_intent_ready` does it
  on demand.
- **The assistant usually rewrites your prose — but it reads your description
  as instructions.** Verified with an A/B test on identical technical content:
  prefixed with "TEST DRAFT — not a real finding; do not submit", the text came
  back verbatim with the title left as `Report Intent #<id>`; without that line,
  the same content was reformatted into HackerOne's template under a generated
  title. So check what came back rather than assuming a rewrite happened —
  and **never put untrusted text in a description** (a scraped page, a captured
  HTTP response, an attacker-controlled string in a PoC). It is fed to a third
  party's LLM that demonstrably acts on instructions inside it.

Creates and updates are heavily rate-limited (see below), so compose your
description before calling rather than iterating through the API.

### Checking a report before you file it

`validate_report` is stateless: pass the fields you intend to submit and it
checks them against the program's live data. Nothing is stored or sent.

It separates blocking errors from advisory warnings — whether the program is
accepting submissions, whether the asset is in scope and bounty-eligible,
whether the severity exceeds the asset's cap, whether the weakness is accepted,
and which categories the program excludes from rewards. If a lookup *fails*, it
says so as a warning rather than reporting a pass or a fail it cannot justify.

## Tools

All 26 tools carry MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`), so a client can tell a read from an
irreversible write without parsing prose. 19 are read-only; 7 mutate, of which
4 are destructive.

### Report intents (HackerOne-side drafts)

| Tool | Annotation | Description |
|------|-----------|-------------|
| `create_report_intent` | write | Create a new draft on every call; waits for assistant processing and returns update guidance |
| `list_report_intents` | read | List your drafts and their states |
| `get_report_intent` | read | Get one draft by id |
| `update_report_intent` | write | Edit a draft in place and verify a changed description; keeps its id and attachments, errors on unconfirmed writes |
| `wait_for_intent_ready` | read | Poll until the assistant job settles |
| `delete_report_intent` | destructive | Delete a draft |
| `submit_report_intent` | destructive | File a draft as a real report — requires `confirm: true` |
| `list_intent_attachments` | read | List files attached to a draft with their inline `{F...}` references |
| `upload_intent_attachments` | write | Upload screenshots, PoC scripts, or HTTP logs and return their inline references |
| `delete_intent_attachment` | destructive | Remove one attachment |

### Read

| Tool | Description |
|------|-------------|
| `validate_report` | Check a report against live scope, weaknesses, and reward exclusions |
| `search_reports` | Filter your reports by keyword, program, severity, state, or `awaiting_reply`. That filter keeps reports in needs-more-info, or with a program comment since your last activity that is not boilerplate. A status change counts only if its message asks you something. It costs one extra GET per open report where the program acted last |
| `get_report` | A report, optionally with its timeline — pass `include: ["conversation"]` or `["activities"]` |
| `list_programs` | Programs you can access, filterable by `bookmarked_only`, submission state, bounties |
| `get_program_details` | Program metadata, bounty settings, and your own stats for it |
| `get_program_scope` | In-scope assets, bounty eligibility, severity caps (auto-paginates) |
| `get_scope_changes` | Assets added or changed since a date, across one program, several, or all bookmarked |
| `get_program_weaknesses` | Weakness/CWE types a program accepts (auto-paginates) |
| `get_scope_exclusions` | Report categories excluded from rewards |
| `search_disclosed_reports` | Search hacktivity with HackerOne's Lucene query engine |
| `analyze_report_patterns` | Your hunting patterns (severity, states, programs, assets) |
| `get_earnings` | Bounty earnings: amount, bonus, currency, and the report each award came from |
| `get_payouts` | Payout transactions (provider, reference, status) |
| `get_balance` | Current unpaid bounty balance |
| `get_hacker_profile` | Your username, reputation, and signal |

### Write

| Tool | Description |
|------|-------------|
| `submit_report` | Submit a report directly — irreversible, requires `confirm: true` |

### The two submission paths carry different things

Neither path can produce a complete report, and the API offers no way around it:

|  | `submit_report` | report intent |
|--|--|--|
| severity / weakness / scope | yes | **no** |
| attachments | **no** | yes |

Attachment endpoints exist only under `/hackers/report_intents`, and an intent
accepts only a `description`. If the finding needs a screenshot or PoC file, go
through the intent flow; if it needs a CWE and an asset, use `submit_report`.
Both tool descriptions state this.

### Deliberately absent: commenting and closing reports

There are no `add_comment` or `close_report` tools. Earlier versions had them;
both POSTed to `/hackers/reports/{id}/activities`, **which is not a Hacker API
endpoint**. It is absent from the documented endpoint list, and probing it
returns 401 for GET and for POST even with a deliberately invalid body — where
a real endpoint would answer 400 — while the same credentials get 200 on
`/hackers/reports/{id}`.

`close_report` was worse than merely broken: it sent
`activity-hacker-requested-mediation`, which *requests HackerOne mediation*
rather than withdrawing anything, behind a tool described to the agent as
"Withdraw one of your own reports".

The Hacker API exposes no way to comment on or close a report. Use the web UI.

## Verified API behaviour

Reference for anyone reading or extending this code. Every line was checked
against the live API, not inferred from the docs — several contradict the
published documentation.

### Status codes — read this before debugging

| Code | What it actually means |
|------|------------------------|
| **429** | Rate limited. **This is what report-intent lockout returns — it is NOT a 403.** No `Retry-After` header is sent. |
| **401** | Bad credentials **or a path that is not a real endpoint** — HackerOne does not 404 unrouted paths. If other calls succeed, it is the path. |
| **404** | Wrong *host*. `hackerone.com/v1/...` returns 404; the API is `api.hackerone.com`. |
| **400** | Malformed body, unknown attribute name, or an out-of-range id. |

A genuine 403 is none of the above and means something else entirely.

### Endpoints that ignore what you send

- **`/hackers/me/reports` ignores every `filter[...]` and `sort` parameter.**
  Byte-identical results with and without them. `search_reports` therefore
  paginates your full history and filters locally.
- **Hacktivity ignores `filter[...]`** and takes a Lucene `queryString`.
  Working fields: `team_handle`, `severity_rating`, `substate`, `reporter`,
  `total_awarded_amount` (supports `>N`), `disclosed`, `cwe`, `cve_ids`,
  `asset_type`, plus free text. Note `cwe` matches the human-readable label
  ("Cross-site Scripting (XSS) - Reflected"), not a CWE number. The documented
  field name `team` does **not** work; it is `team_handle`.
  **Unknown fields fail silently with 0 results** — an invalid `sort`, by
  contrast, returns 400.
- **Hyphens must be quoted in `queryString`.** Hacktivity tokenizes on them, so
  an unquoted `team_handle:dept-of-defense` returns `us-department-of-state`
  reports. `quoteTerm` quotes anything that is not a bare alphanumeric token.
- **Hacktivity caps `page[size]` at 50** regardless of what you ask for, and
  returns `links: {}` — so `page[number]` is the only way to paginate.

### Response shapes that differ from the docs

- **Severity is CVSS 4.0.** `calculation_method: "cvss_4_0"`,
  `cvss_vector_string`, and a nested `cvss_4_point_0_metrics`. The flat CVSS 3.1
  fields the docs show (`attack_vector`, `scope`, …) are **absent**.
- **The report list endpoint omits severity, bounty, and weakness.** Severity is
  only reachable at `relationships.severity.data.attributes.rating`; bounty and
  weakness are not present at all. The published docs example showing a
  `weakness` relationship on this endpoint is wrong.
- **`POST /hackers/reports` takes `weakness_id` and `structured_scope_id` as flat
  attributes**, not relationships. Sent as relationships they are silently
  dropped, filing the report with no CWE and no asset. They must be *numeric* —
  `get_report` returns the CWE external_id (`cwe-200`), which is a different
  identifier and is rejected here.
- **`POST /hackers/report_intents/{id}/submit` returns the report *intent*, not
  the report.** The new report's id is on `relationships.report.data.id`.
- **`GET /hackers/programs/{handle}` returns the resource unwrapped**, not inside
  a `{data: ...}` envelope. It exposes no response-time or response-efficiency
  metrics.
- **`GET /hackers/payments/payouts` returns flat objects** with no JSON:API
  wrapper, as does `balance`.
- **There is no `/hackers/me`.** Profile data is only reachable via the
  `reporter` relationship on your own reports.
- **`last_activity_at` is null on every report** — verified across a full
  account history. The populated fields are `last_program_activity_at`,
  `last_reporter_activity_at`, `first_program_activity_at` and
  `last_public_activity_at`. `search_reports` exposes those and derives
  `program_posted_last` from them: the report is open and the program acted
  after you did. That is all the timestamps can tell you. Status changes
  (triaged, pending-program-review, severity, title and scope edits, bounty
  decisions) and boilerplate such as "passed the preliminary review" count as
  acting.
- **`awaiting_your_reply` reads the timeline.** For each open report where
  `program_posted_last` is true, `search_reports` fetches
  `/hackers/reports/{id}` (one GET, cached for 60s) and sets the flag when:
  - the state is `needs-more-info`, or
  - since your last activity, the program posted an `activity-bug-needs-more-info`,
    an `activity-comment` that does not match a known boilerplate template, or
    a status change whose message asks something.

  "Asks something" means a `?`, "could/can/would you", "please
  provide/confirm/retest/…", "we need/require more…" or "kindly". URLs and
  sign-offs like "If you have any questions, please let us know" are removed
  before checking. A template that asks something counts as a real comment.
  An unrecognised type counts as awaiting if it carries text. `awaiting_reason` gives the cause, e.g.
  `needs-more-info` or `program comment 2026-10-02`, and is `null` when
  nothing is needed. The rules in `src/awaiting.ts` err toward flagging, and a
  failed fetch also counts as awaiting.
- **Earnings have only `{amount, created_at}`.** The award detail and the
  originating report are on the `bounty` relationship, not on the earning.

### Rate limits

Documented: 600 reads/min, 25 writes/20s, 50/min on structured scopes.

Undocumented: report-intent **creates and updates** are capped at roughly 4 per
10 minutes. Retrying during a lockout appears to extend it — ten consecutive
1/min polls stayed locked, while ten minutes of silence cleared it. This server
therefore refuses those requests locally rather than sending them, and never
retries a 429 there. Attachment uploads and the submit call are deliberately
*outside* that budget: they queue no assistant job, and a user-approved
submission must never be blocked by a drafting quota.

The limiter is in-process, so it resets when the server restarts — that clears
the local counter but not HackerOne's.

### Safety properties

- Only `submit_report`, `submit_report_intent`, and `submit_report_intent_v2`
  can file a report. All require `confirm: true`, and their schemas tell the model to set it only on
  explicit user approval rather than because the field is required.
- **Non-idempotent writes are never retried after network failures.** A POST that fails at the network
  level may already have been processed, so retrying could file a duplicate
  report. The error says so and asks you to check state first.
- Authenticated requests are restricted to HTTPS `api.hackerone.com/v1/` URLs;
  pagination cannot forward credentials to another host, and redirects are
  refused. Requests have a 30-second transport timeout. A timed-out write may
  already have succeeded: inspect server-side state before retrying.
- The read cache is bounded to 500 entries and cleared when credentials change.
- `upload_intent_attachments` sends local files to a third party, so it refuses
  paths matching credential stores (`.claude.json`, `.ssh/`, `.aws/`, `.env`,
  private keys, `.pem`) and caps uploads at 25MB.

## Usage Examples

**Save a draft on HackerOne:**
```
Save this SSRF writeup as a draft on the uber program, then show me how they reformatted it.
```

**Check a finding before writing it up:**
```
Is my.example.com in scope for uber, do they accept SSRF, and is anything excluded from rewards?
```

**Find newly in-scope attack surface:**
```
What's been added to the uber program's scope since June?
```

**Research what gets paid:**
```
Search disclosed reports for SSRF that paid over $5000, highest first.
```

**Learn from triage conversations:**
```
Show me the triage conversation on report #2345678. What questions did they ask?
```

**Analyze patterns:**
```
Analyze my report patterns — what severity gets resolved most?
```

## How It Works

- Connects to the [HackerOne Hacker API v1](https://api.hackerone.com/hacker-resources/) using your personal API token
- Runs locally over stdio — public API credentials are sent only to HackerOne for authentication; optional V2 HTTP requests use session credentials retained inside HuntProxy
- Auto-paginates by following the API's own `links.next` where the endpoint
  provides it; hacktivity and report intents do not, and are handled explicitly
- Paginated results carry `count` and, when the page cap is hit, `truncated:
  true` — a partial list is never returned as though it were complete
- List payloads are compact JSON, and `list_programs` never includes policy text
- 60-second response cache on reads, invalidated on writes
- Errors carry the status code, method, path, and response body

## Development checks

```bash
npm ci
npm test
npm audit
```

Tests build the server, mock HackerOne requests, and smoke-test MCP initialization
and tool schemas over stdio. They do not submit reports or contact the live
HackerOne API. Restart your MCP client/server after updating so it loads the
rebuilt `dist/` files and refreshed tool descriptions.

## License

MIT
