# V2 inline screenshot integration result

A synthetic, private test draft was staged using a dedicated test account. It was clearly labelled `TEST DRAFT — inline screenshot integration check — DO NOT SUBMIT`.

- Staged with the compiled V2 HTTP client, with the HuntProxy browser stopped.
- Manual severity: `none` with calculation method `manual` (synthetic test only).
- Uploaded two synthetic 1000×480 PNG screenshots.
- Saved the returned `{F...}` references on the same draft, each beneath its corresponding reproduction step.
- Fresh GraphQL reads confirmed description, severity, attachment membership, and `image/png` content types.
- Reopened that same draft in V2 and selected the description's Preview tab.
- The preview displayed two inline image elements in the expected sections. Both had `complete === true`, `naturalWidth === 1000`, and `naturalHeight === 480`.
- The operator reviewed the draft and confirmed the inline rendering worked correctly.
- No submit mutation was sent; no real report was filed.
- The build and 63 mocked regression tests passed; dependency audit reported zero vulnerabilities.

The final-review browser used an isolated HuntProxy project/profile. Existing workspace files, projects, and browser sessions were not changed.

See the [README](../README.md#setting-up-v2-with-huntproxy) for the optional V2 environment configuration. Use a dedicated authenticated project/exchange and matching expected username. Session renewal may require a human handoff; routine draft HTTP requests do not require a browser.

Account-specific configuration, draft URLs, passwords, MFA seeds, session cookies, CSRF tokens, and signed attachment URLs are intentionally omitted from this public verification record.
