# Graph MCP

Graph MCP is a Node.js MCP server that connects Claude Code and Codex to Microsoft
Teams, Outlook mail and calendar, online meetings, OneDrive, users, and presence through
Microsoft Graph. It runs locally over stdio and requires Node.js 22 or newer.

## What it does

Graph MCP exposes exactly 127 tools:

| Category | Tools |
| --- | --- |
| **Authentication** | Check status, log in with browser or device code, log out |
| **Users and org** | Read your profile, search users, look up a manager or direct reports |
| **People and contacts** | Relevance-ranked people search, list, create, update, or delete Outlook contacts, list contact folders |
| **Search** | Search Teams messages, or search mail, calendar, files, and Teams together in one ranked query |
| **Chats** | List, get, or create chats, read, send, edit, or delete messages, react to messages, rename chats, manage members, mark read |
| **Teams and channels** | List teams, channels, and members, get a team or its primary channel, create channels, read, send, reply, edit, or delete channel messages, reach a channel's SharePoint folder |
| **Calendar** | List calendars and events, get, create, update, cancel, or delete events, recurrence, RSVP, free/busy, suggested meeting times, series occurrences, bookable rooms, shared calendars |
| **Mail** | List, read, search, or delta-sync mail, send, reply, or forward with drafts, bcc, importance, and attachments, move and archive, delete, mark read, flag, categorize, manage folders and inbox rules, mail tips, shared mailboxes |
| **Mailbox settings** | Read mailbox settings, set automatic replies, set time zone and working hours |
| **Meetings** | Resolve a meeting ID from a calendar event, join URL, or meeting chat, look a meeting up by join URL or the numeric invite ID, create or get online meetings with join links, attendance reports, transcripts and recordings |
| **Presence** | Read your own, another user's, or a whole team's presence, set availability or a status message, clear presence |
| **Tasks** | List To Do lists and tasks, create, update, complete, or delete tasks, list assigned Planner tasks |
| **Files** | Browse, search, or resolve links to OneDrive and SharePoint content, upload, download as text or base64 bytes, copy, move, delete, version, and share files, manage permissions, read recent and shared items, read and write Excel ranges |

## Prerequisites

- Node.js 22 or newer.
- A Microsoft Entra ID app registration configured as a **public client** on the
  **Mobile and desktop applications** platform.
- Redirect URI `http://localhost:3000/auth/callback`.
- No client secret. Graph MCP uses delegated user authentication.

Add these exact delegated permissions to the app registration:

- `offline_access`
- `openid`
- `profile`
- `User.Read`
- `User.ReadBasic.All`
- `User.Read.All`
- `Chat.Read`
- `Chat.ReadWrite`
- `ChatMember.ReadWrite`
- `ChatMessage.Send`
- `ChannelMessage.Read.All`
- `ChannelMessage.Send`
- `ChannelMessage.ReadWrite`
- `Channel.Create`
- `TeamMember.Read.All`
- `Team.ReadBasic.All`
- `Channel.ReadBasic.All`
- `ChannelMember.Read.All`
- `Calendars.ReadWrite`
- `Calendars.Read.Shared`
- `Calendars.ReadWrite.Shared`
- `Place.Read.All`
- `Mail.Read`
- `Mail.ReadWrite`
- `Mail.Send`
- `MailboxSettings.ReadWrite`
- `Mail.ReadWrite.Shared`
- `Mail.Send.Shared`
- `Presence.Read`
- `Presence.Read.All`
- `Presence.ReadWrite`
- `OnlineMeetings.Read`
- `OnlineMeetings.ReadWrite`
- `OnlineMeetingArtifact.Read.All`
- `OnlineMeetingTranscript.Read.All`
- `OnlineMeetingRecording.Read.All`
- `Files.ReadWrite.All`
- `Sites.Read.All`
- `People.Read`
- `Contacts.ReadWrite`
- `Tasks.ReadWrite`

Some organizations require administrator consent for one or more permissions. Use the
least privilege your deployment needs and follow your organization's approval process.

## Install

### Claude Code plugin

This repository is itself a plugin marketplace, so Claude Code can install it straight from
GitHub:

```bash
claude plugin marketplace add JustStas/Graph-MCP --scope user
claude plugin install graph-mcp@graph-mcp --scope user
```

The same thing works inside a Claude Code session with `/plugin marketplace add
JustStas/Graph-MCP` followed by `/plugin install graph-mcp@graph-mcp`.

Claude clones the repository into its marketplace cache, validates
`.claude-plugin/marketplace.json`, and installs the self-contained plugin under the plugin
cache. The MCP server launches from the installed plugin bundle, so no source checkout is
needed. To pick up a new release, re-run the two commands.

For plugin development, a local checkout can be added the same way by path instead of
`owner/repo`:

```bash
claude plugin marketplace add /absolute/path/to/Graph-MCP --scope user
claude plugin install graph-mcp@graph-mcp --scope user
```

### Codex plugin

Codex accepts the same GitHub marketplace source:

```bash
codex plugin marketplace add JustStas/Graph-MCP --json
codex plugin add graph-mcp@personal --json
```

`codex plugin marketplace add` takes a local path, `owner/repo[@ref]`, or an HTTPS or SSH Git
URL, and `--ref` pins a specific tag or branch. The Codex manifest launches
`./dist/graph-mcp.js` relative to the installed plugin root, so no source checkout is needed.

For plugin development, point it at a local checkout instead:

```bash
codex plugin marketplace add /absolute/path/to/Graph-MCP --json
codex plugin add graph-mcp@personal --json
```

### npm

Install the public scoped package globally:

```bash
npm install --global @juststas/graph-mcp
graph-mcp setup
```

The npm package is scoped to JustStas, but the installed executable remains graph-mcp.
Invoking graph-mcp without arguments starts the MCP server over stdio.

### Source checkout

```bash
npm ci
npm run build
node dist/cli.js setup
```

Then register the built entrypoint with your host:

```bash
claude mcp add graph-mcp -- node /absolute/path/to/Graph-MCP/dist/cli.js
codex mcp add graph-mcp -- node /absolute/path/to/Graph-MCP/dist/cli.js
```

## First-run setup and authentication

`setup` asks for the Entra application Client ID and Tenant ID and saves them to
`~/.graph-mcp/config.json`. The Client ID and Tenant ID are identifiers, not secrets. The
setup command does not perform login.

For an installed plugin, use the bundled setup skill and its host-specific command:

- Claude Code: `node "${CLAUDE_PLUGIN_ROOT}/dist/graph-mcp.js" setup`
- Codex: resolve the installed plugin root from `skills/setup/SKILL.md`, change to that
  directory, then run `node "./dist/graph-mcp.js" setup`

After setup, call `graph_auth_login`. Browser PKCE login is the default and opens a local
loopback callback on the configured redirect URI. If a browser or loopback callback is
unavailable, call `graph_auth_login` with `method: "device_code"` and follow the returned
Microsoft verification instructions.

Never paste a client secret, access token, refresh token, authorization code, MFA code, or
other credentials into a conversation. Graph MCP does not need a client secret.

## Configuration

For Client ID and Tenant ID, environment variables take precedence over
`~/.graph-mcp/config.json`, which takes precedence over built-in defaults. The setup command
only persists those two identifiers. Other options are environment-only overrides of the
built-in defaults.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AZURE_CLIENT_ID` | Yes | saved `azureClientId`, then empty | Entra public-client application ID |
| `AZURE_TENANT_ID` | No | saved `azureTenantId`, then `common` | Tenant ID or `common` |
| `GRAPH_REDIRECT_URI` | No | `http://localhost:3000/auth/callback` | Must exactly match the app registration |
| `GRAPH_TOKEN_ENCRYPTION_KEY` | No | generated local key | Explicit token-encryption key material |
| `GRAPH_TOKEN_REFRESH_BUFFER` | No | `300` | Refresh access tokens this many seconds before expiry |
| `GRAPH_RATE_LIMIT_MAX_REQUESTS` | No | `10000` | Sliding-window request limit |
| `GRAPH_RATE_LIMIT_WINDOW` | No | `600` | Sliding-window duration in seconds |
| `GRAPH_DEBUG` | No | `false` | Enable diagnostic logging on stderr |

Positive integer options reject zero, negatives, decimals, and malformed values. Boolean
values accept `true`, `false`, `1`, `0`, `yes`, `no`, `on`, or `off`.

## Token storage and migration from Python

The Node server encrypts tokens with AES-256-GCM and stores them under `~/.graph-mcp`:

- `tokens-v2.enc` — encrypted token data
- `.key-v2` — generated local encryption key when no environment key is supplied

The previous Python runtime used `tokens.enc` and `.key`. Version 0.6.0 deliberately does
not read, overwrite, or delete those legacy files because the ciphertext formats differ.
After upgrading from the Python release, authenticate once with `graph_auth_login`; the Node
server then creates its separate versioned token files. Existing Python token files remain
untouched and may be removed later according to your local security policy.

Access tokens refresh automatically before expiry. `graph_auth_logout` clears the Node token
state; it does not modify the legacy Python files.

## Message and email formatting

The Teams message tools (`graph_send_chat_message`, `graph_send_channel_message`, and
`graph_reply_to_channel_message`) and outbound mail tools (`graph_send_mail` and
`graph_reply_mail`) default to HTML mode. When `is_html=true`, pass explicit HTML; Markdown
is not converted automatically.

```html
<p><strong>Status update</strong></p>
<ul>
  <li>Use <code>&lt;strong&gt;</code> for bold text.</li>
  <li>Use <code>&lt;pre&gt;&lt;code&gt;</code> for multi-line code blocks.</li>
</ul>
```

Use `is_html=false` for exact plain text. Mentions may use raw Graph data or this simplified
shape, paired with the corresponding `<at id="0">Jane Smith</at>` tag in the HTML body:

```json
[
  {
    "name": "Jane Smith",
    "user_id": "ef1c916a-3135-4417-ba27-8eb7bd084193"
  }
]
```

## Development and verification

Install the locked dependencies and run the complete Node verification pipeline:

```bash
npm ci
npm run verify
```

Useful individual commands:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run validate:versions
npm run validate:package
npx vitest run tests/plugin-install-smoke.test.ts
```

Plugin and release validation:

```bash
claude plugin validate --strict plugins/graph-mcp
claude plugin validate --strict .
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/graph-mcp
node scripts/test-plugin-install.mjs
npm pack --json --dry-run
```

The Codex validator is release tooling supplied by Codex's `plugin-creator` skill; Python is
not required to build, test, or run Graph MCP itself. Before publishing, verify that package,
Claude manifest, and Codex manifest versions match the target release, the committed plugin
bundle is current, both installed plugins expose exactly 127 tools, and the working tree is clean.

### Release procedure

Graph MCP releases use the public npm package `@juststas/graph-mcp`; there is no Python/PyPI
release step. Version 0.6.0 completed the Node migration but was not published to npm because
npm rejected the unscoped `graph-mcp@0.6.0` name as too similar to the existing `graphmcp`
package. Version 0.6.1 is the first scoped npm release.

#### Normal releases

1. Update `package.json`, `package-lock.json`, both plugin manifests, runtime metadata,
   `CHANGELOG.md`, and the committed plugin bundle to one version.
2. Run `npm ci`, `npm run verify`, `node scripts/test-plugin-install.mjs`, and
   `npm pack --json --dry-run` from a clean worktree.
3. Merge the reviewed pull request to `main`. A repository administrator then creates the
   annotated `v<version>` tag on the merged commit through the mandatory release-tag authority
   ruleset; the separate no-bypass immutability ruleset blocks later update or deletion.
4. Publish the matching GitHub Release. The workflow trigger is `release: types: [published]`.
5. The package job installs locked dependencies, runs `npm run verify`, and prepares the exact
   tarball without OIDC permission.
6. The publish job runs in the `npm` GitHub environment and is the only job that receives OIDC
   permission. It downloads a data-only artifact containing the tarball and metadata, checks
   out its trusted helper at `github.workflow_sha`, binds the expected tag directly to the
   release event, validates npm's JSON dry-run manifest for the exact private snapshot, and
   uses npm Trusted Publishing. It has no `NODE_AUTH_TOKEN` or npm secret.
7. Verify the workflow, npm version, `dist.integrity`, installed CLI version, and 127-tool MCP
   inventory.

Workflow reruns are idempotent. If the version already exists, the workflow succeeds only
when npm's dist.integrity equals the prepared tarball. A different integrity fails and
requires a new patch version.

#### First scoped-package bootstrap

npm requires a package to exist before Trusted Publishing can be configured. Bootstrap the first
scoped release in this order:

1. Verify merged `main`, then activate the administrator-authority `v*` ruleset.
2. Audit the exact historical tag inventory and ancestry, require the exact allowlisted
   historical PyPI workflow blob where expected, and require the new release helper to be absent
   everywhere.
3. Activate the separate no-bypass immutability ruleset.
4. Create the annotated `v0.6.1` tag only after those gates pass.
5. Run `publish.yml` from `main` with `prepare_only` enabled and inspect its prepared artifact.
6. Validate the exact filename, regular-file status, SHA-512 and SHA-1 digests, and npm's JSON
   dry-run manifest. Publish that same private snapshot once with the maintainer's interactive
   2FA, explicit npmjs registry, `latest` tag, disabled lifecycle scripts, and public access;
   then verify its registry version and integrity.
7. Reverify both release-tag rulesets.
8. Create the `npm` GitHub environment.
9. Add separate typed environment policies for branch `main` and tag `v*`.
10. Verify both rulesets and both typed environment policies.
11. Configure npm Trusted Publishing:

```bash
npx --yes npm@11.15.0 trust github @juststas/graph-mcp \
  --file publish.yml \
  --repo JustStas/Graph-MCP \
  --env npm \
  --allow-publish
```

Verify the saved repository, workflow filename, environment, and publish permission, then
set npm publishing access to require 2FA and disallow traditional tokens.

The manual 0.6.1 bootstrap uses neither OIDC nor provenance, and its integrity-matched release
workflow is a no-op that does not test the OIDC exchange. Version 0.6.2 is the first real OIDC
publish and provenance check.

#### Recovery

Use `workflow_dispatch` from `main` with an existing protected tag to rerun publication. Use
`prepare_only` when only the verified tarball is needed. The release-tag rulesets prohibit
moving or deleting published `v*` tags. Never overwrite an npm version; recover from a bad
publication with a new patch release.

## Architecture and runtime behavior

```text
Claude Code or Codex  --stdio-->  Graph MCP  --HTTPS-->  Microsoft Graph API
                                      |
                                ~/.graph-mcp/
                                  config.json
                                  tokens-v2.enc
                                  .key-v2
```

- Authentication uses OAuth 2.0 Authorization Code with PKCE or device code.
- Access-token refresh is serialized so concurrent Graph calls share one refresh.
- Graph requests use bounded timeouts, sliding-window rate limiting, and exponential retry
  behavior that honors `Retry-After` on throttled responses.
- MCP protocol output is written to stdout; diagnostics are written to stderr.

## Troubleshooting

**Approval required during login**

Confirm that the exact delegated permissions above are present and that required
administrator consent has been granted.

**403 Forbidden for one tool**

The endpoint may need a delegated permission or administrator consent not available to the
signed-in user. Check the tool's permission and your organizational policy.

**Browser callback is unavailable**

Call `graph_auth_login` with `method: "device_code"` and complete sign-in at the Microsoft
verification URL.

**Configuration changed but the host still uses old values**

Restart the MCP server or host so the process reloads `config.json` and its environment.
Environment variables override saved Client ID and Tenant ID values.

**Upgraded from the Python release and appear logged out**

This is expected once. Run `graph_auth_login`; the Node runtime creates `tokens-v2.enc` and
`.key-v2` without changing the old `tokens.enc` and `.key` files.

## Disclaimer

This project is an independent open-source effort and is **not affiliated with, endorsed by,
or sponsored by Microsoft Corporation**. Microsoft, Microsoft Teams, Outlook, Microsoft 365,
Microsoft Graph, and Azure are trademarks of the Microsoft group of companies.

This software is provided "as is", without warranty of any kind. Use it at your own risk.
The authors accept no liability for damages, data loss, or security issues arising from its
use. You are responsible for complying with your organization's policies and Microsoft's
[API Terms of Use](https://learn.microsoft.com/en-us/legal/microsoft-apis/terms-of-use).

This software accesses Microsoft services on your behalf using your own credentials and app
registration. Data retrieved from Microsoft Graph (including mail, messages, calendar events,
meetings, and files) is passed to the model that invoked the tool. Follow BP and your
organization's data-handling, retention, and acceptable-use requirements when using
cloud-hosted AI models.

## License

MIT — see [LICENSE](LICENSE).
