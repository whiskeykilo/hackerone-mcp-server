# Agent instructions

This is a **public** repository. Everything committed here, including commit
messages, PR text and test fixtures, is visible to anyone, and it stays in git
history and in GitHub's fork network after it's deleted. Removing it later
takes a history rewrite and, often, a request to GitHub Support.

## Never commit

- **HackerOne report data:** real report IDs, report or activity text, triage
  comments, titles, CVSS vectors, timestamps, or attachment URLs.
- **Program details:** names or handles of programs the operator hunts on, their
  assets, or the product versions found to be vulnerable.
- **People:** the operator's HackerOne username in report contexts (mentions,
  `username` fields), analyst or program-staff usernames.
- **Secrets and sessions:** API tokens, cookies, CSRF tokens, HuntProxy project
  or exchange IDs, signed URLs, or anything from `~/.claude.json`, `~/.pi`,
  `~/.huntproxy` or `~/aegis`.
- **Local paths and machine details** beyond generic examples like `/path/to/...`.

## Test fixtures

Fixtures in `test/fixtures/` must be synthetic. If you record a real API
response to build one, replace every identifying value before it's staged:

| Field | Use |
|--|--|
| Report ids and file names | `1000000`–`1000099` |
| Activity ids | `50000000`–`50000999` |
| Reporter | `example-hacker` |
| Staff | `h1_analyst_a`, `program_member_a`, … (`hackerone-agent` is fine) |
| Program or company names | "the program team", "Example Corp" |
| Product versions | `1.2.3` |
| Timestamps | Shift the year to 2020 and keep the relative order |

Keep only the fields a test reads. `test/fixtures-synthetic.test.mjs` enforces
the id, username, link and timestamp rules.

## Checks that run

- **Locally:** a `git-sensitive-check` pre-commit and pre-push hook, if it's
  installed on the machine, blocks known program names and report ids. Never
  bypass it with `--no-verify`. If it reports a false positive, tell the
  operator rather than working around it.
- **CI:** `npm test` (including the fixture rules) and a gitleaks secret scan.

If you find sensitive data already committed, stop and tell the operator. Don't
try to fix it with a normal follow-up commit, because the data stays in history.

## Development

```bash
npm ci
npm run typecheck
npm test
```

See the README for setup and `docs/api-notes.md` before changing API behaviour.
