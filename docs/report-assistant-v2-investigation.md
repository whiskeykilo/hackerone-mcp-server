# Report Assistant V2: HTTP integration findings

Observed against `https://hackerone.com/hai/report_assistant?v2=1` using a dedicated test account and an isolated HuntProxy project. No reports were submitted. No Aegis workspace files, projects, or browser sessions were changed.

## Confirmed behavior

V2 uses `POST https://hackerone.com/graphql`, not a separate public REST API version. The observed requests authenticate with web-session cookies and `X-CSRF-Token`. Public API token authentication was not tested; do not assume it works for this endpoint.

The following were exercised successfully:

- Creating a private draft through `createReportIntentV2`.
- Saving title, description, impact, and manual severity through `saveReportIntent`.
- Uploading an attachment through `uploadReportIntentAttachments`.
- Removing a duplicate synthetic attachment through `deleteReportIntentAttachments`.
- With the isolated Chromium session **stopped**, authenticated HTTP requests through HuntProxy's `reply_send` successfully read draft history, saved impact and manual severity, uploaded a file, and removed a duplicate attachment. These operations do not require browser execution once a usable authenticated request is available.

V2 lifecycle differs from V1: an unchecked draft can remain `pending` while accepting `saveReportIntent` and attachment operations. The shipped UI disables editing based on an active conversation agent, not `state === "pending"`; final submission still requires `ready_to_submit`. Do not reuse V1's pending-edit prohibition for V2.

This establishes HTTP-only operation using HuntProxy's transport and captured session. It does **not** establish that ordinary Node.js `fetch` will pass Cloudflare or that login can always be performed without a browser. Session expiry or Cloudflare challenges may require a fresh login/human handoff.

## Observed operations

### Create

```graphql
mutation CreateReportIntentV2($input: CreateReportIntentV2Input!) {
  createReportIntentV2(input: $input) {
    was_successful
    report_intent { id _id }
    errors { edges { node { message } } }
  }
}
```

Input: `{ "team_id": "<opaque GraphQL program ID>" }`.

### Save

```graphql
mutation SaveReportIntent($input: SaveReportIntentInput!) {
  saveReportIntent(input: $input) {
    was_successful
    report_intent {
      id _id title impact
      severity { rating calculation_method }
      attachments { id file_name }
    }
    errors { edges { node { message } } }
  }
}
```

Observed input fields include `report_intent_id`, `title`, `description`, `impact`, `structured_scope_id`, `weakness_id`, `pentest_check_id`, `custom_field_values`, and `severity_hash`. Optional fields should be omitted unless deliberately changed.

Manual severity saved successfully as:

```json
{
  "severity_hash": {
    "calculation_method": "manual",
    "type": "manual",
    "rating": "none"
  }
}
```

`none` is a deliberate rating here, not an unset field. Do not infer the user's intended rating or silently default real reports to it. The UI also offers low, medium, high, and critical; only none was used for this synthetic test.

### Upload

The request uses the GraphQL multipart request format:

- `operations`: JSON containing `operationName`, `query`, and `variables.input` with `report_intent_id` and `files: [null]`.
- `map`: e.g. `{ "1": ["variables.input.files.0"] }`.
- `1`: the actual file part, with filename and content type.

```graphql
mutation UploadReportIntentAttachments($input: UploadReportIntentAttachmentsInput!) {
  uploadReportIntentAttachments(input: $input) {
    was_successful
    attachments { id _id file_name file_size content_type }
    errors { edges { node { message } } }
  }
}
```

The UI also requests expiring attachment URLs and analysis status. Avoid retaining signed download URLs in logs or fixtures. Attachment references use the numeric `_id`: `{F<numeric id>}`.

### Delete attachment

```graphql
mutation DeleteReportIntentAttachmentsV2($input: DeleteReportIntentAttachmentsInput!) {
  deleteReportIntentAttachments(input: $input) {
    was_successful
    report_intent { id attachments { id file_name } }
  }
}
```

Input: `{ "report_intent_id": "<opaque ID>", "attachment_ids": ["<opaque attachment ID>"] }`.

## Submission: observed client code only, not executed

The shipped router contains `SubmitReportIntentV2Mutation`, calling `submitReportIntent` with `SubmitReportIntentInput` and `report_intent_id`. The UI flushes pending autosaves before submission. A production implementation should explicitly await and verify saved fields before any final submit request, require fresh explicit approval, never retry an ambiguous submission, and check for an existing report after an uncertain result.

The test account's UI displayed identity-verification and program Signal requirements. These requirements must be respected. No submit request was sent, and end-to-end submission is not verified.

## Evidence anchors (local HuntProxy project 90)

- Exchange 207: V2 draft creation.
- Exchange 269: UI save with `calculation_method: manual`.
- Exchange 277: UI multipart upload.
- Exchange 305: HTTP-only draft-history read.
- Exchange 313: HTTP-only impact/manual-severity save.
- Exchange 314: HTTP-only multipart attachment upload.
- Exchange 315: HTTP-only duplicate attachment removal.

Shipped router captured in exchange 187. Credentials, session cookies, CSRF values, passwords, MFA seeds, and signed URLs are intentionally omitted from this document.
