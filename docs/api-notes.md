# Verified HackerOne API behaviour

Notes for anyone debugging or extending this server. Everything here was
checked against the live API rather than inferred from the docs, and several
points contradict the published documentation.

## Deliberately absent: commenting and closing reports

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

## Status codes — read this before debugging

| Code | What it actually means |
|------|------------------------|
| **429** | Rate limited. **This is what report-intent lockout returns — it is NOT a 403.** No `Retry-After` header is sent. |
| **401** | Bad credentials **or a path that is not a real endpoint** — HackerOne does not 404 unrouted paths. If other calls succeed, it is the path. |
| **404** | Wrong *host*. `hackerone.com/v1/...` returns 404; the API is `api.hackerone.com`. |
| **400** | Malformed body, unknown attribute name, or an out-of-range id. |

A genuine 403 is none of the above and means something else entirely.

## Endpoints that ignore what you send

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

## Response shapes that differ from the docs

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

## Rate limits

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

## Safety properties

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

## How the server talks to HackerOne

- Connects to the [HackerOne Hacker API v1](https://api.hackerone.com/hacker-resources/) using your personal API token
- Runs locally over stdio — public API credentials are sent only to HackerOne for authentication; optional V2 HTTP requests use session credentials retained inside HuntProxy
- Auto-paginates by following the API's own `links.next` where the endpoint
  provides it; hacktivity and report intents do not, and are handled explicitly
- Paginated results carry `count` and, when the page cap is hit, `truncated:
  true` — a partial list is never returned as though it were complete
- List payloads are compact JSON, and `list_programs` never includes policy text
- 60-second response cache on reads, invalidated on writes
- Errors carry the status code, method, path, and response body
