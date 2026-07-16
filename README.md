# Graph MCP

Graph MCP is a Node.js MCP server that connects Claude Code and Codex to Microsoft
Teams, Outlook mail and calendar, online meetings, OneDrive, users, and presence through
Microsoft Graph. It runs locally over stdio and requires Node.js 22 or newer.

## What it does

Graph MCP exposes exactly 44 tools:

| Category | Tools |
| --- | --- |
| **Authentication** | Check status, log in with browser or device code, log out |
| **Users and presence** | Read your profile, search users, read presence, set your presence |
| **Search** | Search messages across chats and channels |
| **Chats** | List chats, read or send messages, create chats, list members |
| **Teams and channels** | List teams and channels, read or send messages and replies, list members |
| **Calendar** | List calendars and events, get, create, update, or delete events |
| **Mail** | List, read, or search mail, send or reply, list or download attachments |
| **Meetings** | List online meetings, transcripts, and recordings; read transcript content or recording URLs |
| **Files** | Browse or search OneDrive, download or upload content, create sharing links |

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
- `Chat.Read`
- `Chat.ReadWrite`
- `ChatMessage.Send`
- `ChannelMessage.Read.All`
- `ChannelMessage.Send`
- `Team.ReadBasic.All`
- `Channel.ReadBasic.All`
- `ChannelMember.Read.All`
- `Calendars.ReadWrite`
- `Mail.Read`
- `Mail.Send`
- `Presence.Read`
- `Presence.Read.All`
- `Presence.ReadWrite`
- `OnlineMeetings.Read`
- `OnlineMeetingTranscript.Read.All`
- `OnlineMeetingRecording.Read.All`
- `Files.ReadWrite.All`

Some organizations require administrator consent for one or more permissions. Use the
least privilege your deployment needs and follow your organization's approval process.

## Install

### Claude Code plugin

From a local checkout of this repository:

```bash
claude plugin marketplace add /absolute/path/to/Graph-MCP --scope user
claude plugin install graph-mcp@graph-mcp --scope user
```

The marketplace installs the self-contained plugin under Claude's plugin cache. Its MCP
server launches from the installed plugin bundle, not from the source checkout.

### Codex plugin

From a local checkout of this repository:

```bash
codex plugin marketplace add /absolute/path/to/Graph-MCP --json
codex plugin add graph-mcp@personal --json
```

The Codex manifest launches `./dist/graph-mcp.js` relative to the installed plugin root.

### npm

Install the CLI globally:

```bash
npm install --global graph-mcp
graph-mcp setup
```

The `graph-mcp` executable starts the MCP server when invoked without arguments. Register
that executable with your MCP host using its normal MCP-server configuration.

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
Claude manifest, and Codex manifest versions are all `0.6.0`, the committed plugin bundle is
current, both installed plugins expose exactly 44 tools, and the working tree is clean.

### Release procedure

Graph MCP 0.6.0 is released as an npm package. The obsolete Python/PyPI publishing workflow
has been removed. Publish only from an approved release commit whose package version, both
plugin manifest versions, changelog entry, and `v0.6.0` tag agree.

1. Update the version in `package.json`, `package-lock.json`, and both plugin manifests, update
   `CHANGELOG.md`, and rebuild the committed plugin artifact.
2. Run the complete verification and plugin validation commands above from a clean checkout.
3. Inspect the exact npm payload and confirm the repository is clean:

   ```bash
   npm pack --json --dry-run
   git status --short
   ```

4. After the pull request is merged, create the `v0.6.0` tag from the merged `main` commit and
   create the matching GitHub release. Configure npm authentication in the release environment
   or local user configuration. Never commit an npm token.
5. Publish the public package and verify the registry version:

   ```bash
   npm publish --access public
   npm view graph-mcp version
   ```

There is no Python/PyPI publishing step in the Node release. Any future GitHub Actions npm
publishing workflow should run these same locked install, verification, validator, smoke, and
publish commands from the protected version tag.

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
