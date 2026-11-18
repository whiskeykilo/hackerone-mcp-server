# Drafting reports in detail

The [README](../README.md) covers the short version. This page has the full
behaviour of both draft backends, the V1 manual-severity problem, and
`validate_report`.

V2 needs [HuntProxy](https://github.com/BehiSecc/HuntProxy); see the README for setup.

## Preferred: Report Assistant V2 over HTTP

The normal intent tools now **prefer V2 when configured**. V2 can save title,
description, impact, manual severity, asset, weakness, and attachments together.
Routine requests use [HuntProxy](https://github.com/BehiSecc/HuntProxy)'s HTTP transport, **not browser automation**.
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

See [verified V2 protocol findings](report-assistant-v2-investigation.md).

## Public API / V1 compatibility workflow

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

## Manual severity error in Report Assistant V1

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

## Checking a report before you file it

`validate_report` is stateless: pass the fields you intend to submit and it
checks them against the program's live data. Nothing is stored or sent.

It separates blocking errors from advisory warnings — whether the program is
accepting submissions, whether the asset is in scope and bounty-eligible,
whether the severity exceeds the asset's cap, whether the weakness is accepted,
and which categories the program excludes from rewards. If a lookup *fails*, it
says so as a warning rather than reporting a pass or a fail it cannot justify.

## The two submission paths carry different things

Neither path can produce a complete report, and the API offers no way around it:

|  | `submit_report` | report intent |
|--|--|--|
| severity / weakness / scope | yes | **no** |
| attachments | **no** | yes |

Attachment endpoints exist only under `/hackers/report_intents`, and an intent
accepts only a `description`. If the finding needs a screenshot or PoC file, go
through the intent flow; if it needs a CWE and an asset, use `submit_report`.
Both tool descriptions state this.
