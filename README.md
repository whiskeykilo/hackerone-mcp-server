# HackerOne MCP Server

[![CI](https://github.com/whiskeykilo/hackerone-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/whiskeykilo/hackerone-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 22+](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)

Talk to your HackerOne account from Claude Code (or any MCP client). Ask about
your reports, check scope before you write something up, research disclosed
reports, track earnings, and draft and submit reports, all without leaving
your editor.

> **Disclaimer:** This is an unofficial, community-built project. It is not
> affiliated with, endorsed by, or maintained by HackerOne. "HackerOne" is a
> trademark of HackerOne, Inc. The project uses their publicly documented
> [Hacker API](https://api.hackerone.com/hacker-resources/).

## What you can ask

```text
Is my.example.com in scope for uber, do they accept SSRF, and is anything excluded from rewards?
```

```text
Which of my reports are waiting on a reply from me?
```

```text
What's been added to the uber program's scope since June?
```

```text
Search disclosed reports for SSRF that paid over $5000, highest first.
```

```text
Show me the triage conversation on report #2345678. What questions did they ask?
```

```text
Save this SSRF writeup as a draft on the uber program, then show me how they reformatted it.
```

Nothing is ever filed without your explicit approval.

## Quick start

You need Node.js 22 or newer and a HackerOne API token (**HackerOne > Settings > API Token**).

```bash
git clone https://github.com/whiskeykilo/hackerone-mcp-server.git
cd hackerone-mcp-server
npm install
npm run build

claude mcp add hackerone \
  -e H1_USERNAME=your-username \
  -e H1_API_TOKEN=your-api-token \
  -s user \
  -- node "$PWD/dist/index.js"
```

Run `claude`, then `/mcp`. You should see `hackerone` and its tools listed.

<details>
<summary>Prefer editing <code>~/.claude.json</code> by hand?</summary>

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

</details>

That's all you need for everything except the richer drafting workflow below.
Any other MCP client works the same way: run `node dist/index.js` with
`H1_USERNAME` and `H1_API_TOKEN` in its environment.

## Drafting reports

HackerOne calls a server-side draft a **report intent**. The flow is the same
whichever backend you use:

1. **Create** a draft once.
2. **Upload** screenshots or PoC files to it. Each upload returns a reference
   like `{F123456}`.
3. **Update** the same draft, putting those references in the description.
4. **Review** what HackerOne made of it.
5. **Submit** it, only after you say so.

To change a draft, update it. Don't create a new one, because every create
call makes a separate draft.

### Two backends

| | **V1** (public API) | **V2** (Report Assistant, optional) |
|--|--|--|
| Setup | Works out of the box | Needs [HuntProxy](https://github.com/BehiSecc/HuntProxy) and a logged-in web session |
| Title, impact, severity, asset, weakness | No (description only) | Yes |
| Attachments | Yes | Yes |
| Official API | Yes | No: uses HackerOne's web GraphQL, which may change |

With the default `version: "auto"`, the server uses V2 if it's configured and
falls back to V1 (with a warning) only when V2 isn't configured at all. Once a
draft exists, it stays on the backend it was created with.

### Setting up V2 with HuntProxy

[HuntProxy](https://github.com/BehiSecc/HuntProxy) is a web security
workbench built for AI agents. This server launches it (`HuntProxy mcp`) to
send HackerOne web requests with a session you've logged into. Your session
cookies stay inside HuntProxy and never reach this repo or its config.

1. Install HuntProxy by following its README.
2. Create a **dedicated** HuntProxy project, and log in to HackerOne in it as
   the account you want to use.
3. In that project, find a captured, authenticated `POST https://hackerone.com/graphql`
   request. Note its exchange ID.
4. Add these to the MCP server's environment:

   ```text
   H1_V2_HUNTPROXY_PROJECT_ID=<your HuntProxy project ID>
   H1_V2_HUNTPROXY_EXCHANGE_ID=<the exchange ID from step 3>
   H1_V2_USERNAME=<your HackerOne username>
   H1_V2_HUNTPROXY_COMMAND=/home/you/.local/bin/HuntProxy
   # Optional, if HuntProxy uses a non-default data directory:
   # H1_V2_HUNTPROXY_DATA_DIR=/path/to/private/huntproxy-data
   ```

5. Restart your MCP client and ask it to run `get_report_assistant_v2_status`.

Before every write, the server checks that the logged-in account matches
`H1_V2_USERNAME`. If the session expires or Cloudflare challenges it, log in
again in HuntProxy. Treat HuntProxy's data directory as sensitive, because it
holds your session.

V2 final submission has not been tested against the live site yet.

### Things that will surprise you

- **HackerOne's assistant reads your description as instructions.** It's fed
  to their LLM, so never paste untrusted text into a draft: scraped pages,
  captured responses, or attacker-controlled strings.
- **Drafting is heavily rate-limited.** Creates and updates are capped at
  roughly 4 per 10 minutes, and retrying during a lockout extends it. Write
  the description first, then send it.
- **The two submission paths carry different things.** `submit_report` can set
  severity, weakness and asset but can't attach files. A V1 draft can attach
  files but can't set those fields. V2 can do both.
- **There's no commenting or closing.** The Hacker API doesn't support either,
  so use the web UI.

The full detail, including V1's manual-severity error and how updates are
verified, is in [docs/drafting-reports.md](docs/drafting-reports.md).

## Tools

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, …), so
your client can tell reads from irreversible writes. Anything that files a
report requires `confirm: true`.

**Your reports and account**

| Tool | What it does |
|------|--------------|
| `search_reports` | Filter your reports by keyword, program, severity, state, or `awaiting_reply` |
| `get_report` | One report, optionally with its conversation or activity timeline |
| `analyze_report_patterns` | Your hunting patterns by severity, state, program and asset |
| `get_earnings` / `get_payouts` / `get_balance` | Bounties, payout transactions, unpaid balance |
| `get_hacker_profile` | Your username, reputation and signal |

**Programs and research**

| Tool | What it does |
|------|--------------|
| `list_programs` | Programs you can access (filter by bookmarked, submission state, bounties) |
| `get_program_details` | Program metadata, bounty settings, and your stats for it |
| `get_program_scope` | In-scope assets, bounty eligibility, severity caps |
| `get_scope_changes` | Assets added or changed since a date |
| `get_program_weaknesses` | Weakness/CWE types a program accepts |
| `get_scope_exclusions` | Report categories excluded from rewards |
| `search_disclosed_reports` | Search hacktivity with Lucene queries |
| `validate_report` | Check a report you're about to file against live scope, weaknesses and exclusions |

**Drafts and submission**

| Tool | What it does |
|------|--------------|
| `create_report_intent` | Create a new draft (every call makes a new one) |
| `update_report_intent` | Edit a draft in place and check the change actually stuck |
| `list_report_intents` / `get_report_intent` | See your drafts |
| `wait_for_intent_ready` | Wait for HackerOne's assistant to finish processing |
| `upload_intent_attachments` / `list_intent_attachments` | Attach files and get their `{F...}` references |
| `delete_intent_attachment` / `delete_report_intent` | Remove an attachment or a draft |
| `submit_report_intent` | File a draft as a real report (needs `confirm: true`) |
| `submit_report` | File a report directly, without attachments (needs `confirm: true`) |
| `get_report_assistant_v2_status` | Check that the V2 setup works |

The draft tools also have explicit `*_v2` versions (for example
`create_report_intent_v2` and `search_report_programs_v2`) that always use V2.

## Safety

- Nothing is submitted without `confirm: true`, and the tool descriptions tell
  the model to set it only when you approve.
- Writes that might have gone through are never retried automatically, so a
  network blip can't file a duplicate report.
- API credentials are only ever sent to `https://api.hackerone.com/v1/`.
- Uploads refuse obvious credential files (`.ssh/`, `.aws/`, `.env`, private
  keys) and cap at 25MB.

## Troubleshooting

| Symptom | Likely cause |
|--|--|
| `hackerone` missing from `/mcp` | The path to `dist/index.js` is wrong, or you didn't run `npm run build` |
| Every call returns **401** | Wrong username or token. If only *some* calls fail, see [api-notes](docs/api-notes.md#status-codes--read-this-before-debugging): HackerOne also returns 401 for unknown paths |
| Draft creates or updates return **429** | You hit the drafting limit (about 4 per 10 minutes). Stop and wait about 10 minutes, because retrying extends the lockout |
| V2 says the account doesn't match or the session expired | Log in again in HuntProxy, capture a fresh `/graphql` request, and update `H1_V2_HUNTPROXY_EXCHANGE_ID` |
| Changes to the server don't show up | Rebuild, then restart your MCP client so it reloads `dist/` |

## Further reading

- [docs/drafting-reports.md](docs/drafting-reports.md): the full draft
  workflow for V1 and V2, and the manual-severity problem
- [docs/api-notes.md](docs/api-notes.md): verified API quirks, status codes,
  rate limits and safety details. Read it before debugging or extending the server.
- [docs/report-assistant-v2-investigation.md](docs/report-assistant-v2-investigation.md):
  how the V2 GraphQL protocol was worked out

## Development

```bash
npm ci
npm run typecheck
npm test        # builds first, then runs the node:test suite
npm audit
```

Tests mock HackerOne and never contact the live API or submit anything. CI
runs the same checks on Node 22 and 24 for every push and pull request.

## License

[MIT](LICENSE). Originally created by
[Sicks3c](https://github.com/Sicks3c/hackerone-mcp-server); this fork adds the
Report Assistant V2 workflow and verified update and attachment handling.
