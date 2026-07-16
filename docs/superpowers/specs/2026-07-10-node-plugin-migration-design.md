# Graph MCP Node and Dual-Host Plugin Migration Design

**Date:** 2026-07-10
**Status:** Approved for specification
**Target release:** 0.6.0

## Summary

Migrate Graph MCP from Python to a self-contained Node.js/TypeScript MCP server while preserving its public behavior. Package the compiled server as one plugin that can be installed by both Claude Code and Codex, with official manifests and marketplace metadata for each host.

The migration will preserve the existing Microsoft Graph integrations and tool contracts, improve first-run configuration for plugin users, and add a device-code authentication fallback without breaking the current browser-based login flow.

## Goals

- Replace the Python runtime with a Node.js 22+ TypeScript implementation.
- Preserve all 44 tools currently registered by the Python source.
- Preserve tool names, every existing parameter and default, Graph endpoints, delegated scopes, formatting rules, and JSON response envelopes. The only schema addition is the optional authentication method described below.
- Preserve browser-based OAuth2 Authorization Code flow with PKCE as the default.
- Add device-code authentication for headless and remote environments.
- Produce a single-file MCP runtime bundle that does not require an install-time `npm install`.
- Package the same bundle for Claude Code and Codex using each host's official plugin manifest and marketplace layout.
- Keep the package independently publishable to npm as `graph-mcp`.
- Add sufficient automated tests to demonstrate behavioral and packaging parity.
- Document installation, Azure app registration, authentication, migration, local development, and release procedures.

## Non-goals

- Publishing the npm package or submitting it to a hosted marketplace during implementation.
- Introducing application permissions, client secrets, or a shared project-owned Azure application.
- Adding new Microsoft Graph product areas beyond the current tools.
- Rewriting tool outputs into a new structured response format.
- Preserving the Python token ciphertext format.
- Refactoring unrelated Microsoft Graph behavior during the language migration.

## Authoritative Current State

The current README states that the server exposes 41 tools, but the source registers 44 `@mcp.tool()` functions. The source is authoritative, so the Node implementation and updated README will use 44.

| Category | Count |
|---|---:|
| Authentication | 3 |
| Profile | 1 |
| Chats | 5 |
| Teams and channels | 7 |
| Calendar | 6 |
| Mail | 7 |
| Users | 1 |
| Presence | 3 |
| Search | 1 |
| Online meetings | 5 |
| OneDrive files | 5 |
| **Total** | **44** |

The existing public tool names are:

`graph_auth_status`, `graph_auth_login`, `graph_auth_logout`,
`graph_get_profile`, `graph_list_chats`, `graph_get_chat_messages`,
`graph_send_chat_message`, `graph_create_chat`, `graph_list_chat_members`,
`graph_list_teams`, `graph_list_channels`, `graph_get_channel_messages`,
`graph_send_channel_message`, `graph_list_channel_members`,
`graph_get_channel_message_replies`, `graph_reply_to_channel_message`,
`graph_list_calendars`, `graph_list_events`, `graph_get_event`,
`graph_create_event`, `graph_update_event`, `graph_delete_event`,
`graph_list_mail`, `graph_read_mail`, `graph_search_mail`,
`graph_send_mail`, `graph_reply_mail`, `graph_list_mail_attachments`,
`graph_get_mail_attachment`, `graph_search_users`,
`graph_get_my_presence`, `graph_get_user_presence`,
`graph_set_my_presence`, `graph_search_messages`,
`graph_list_online_meetings`, `graph_list_meeting_transcripts`,
`graph_get_meeting_transcript_content`,
`graph_list_meeting_recordings`, `graph_get_meeting_recording_url`,
`graph_list_files`, `graph_search_files`, `graph_get_file_content`,
`graph_upload_file`, and `graph_share_file`.

## Approaches Considered

### 1. Direct TypeScript port using Microsoft Graph REST

Use the official MCP TypeScript SDK, Zod schemas, native `fetch`, Node crypto, and small focused modules corresponding to the existing Python design.

**Advantages**

- Closest behavioral match to the current server.
- Small runtime dependency surface.
- Straightforward request-level tests.
- Easy to bundle into one executable JavaScript file.
- Avoids Graph SDK abstractions changing query or response behavior.

**Disadvantages**

- OAuth and retry behavior remain project-owned code.

### 2. MSAL Node plus Microsoft Graph JavaScript SDK

Use Microsoft's authentication and Graph client libraries.

**Advantages**

- More vendor-owned authentication and request plumbing.
- Built-in token cache concepts.

**Disadvantages**

- Larger bundle and more transitive dependencies.
- Harder to preserve exact REST request behavior.
- More mocks and adapters are required for tool-level tests.
- Migration risk is higher because both language and client abstraction change.

### 3. Node launcher around the existing Python package

Ship a Node executable that starts the Python server.

**Advantages**

- Minimal porting work.

**Disadvantages**

- Not a real Node migration.
- Plugin users still need Python and the Python package.
- Cross-platform installation remains fragile.

### Decision

Use approach 1: a direct TypeScript port using raw Microsoft Graph REST calls.

## Repository Layout

```text
Graph-MCP/
├── .agents/
│   └── plugins/
│       └── marketplace.json
├── .claude-plugin/
│   └── marketplace.json
├── docs/
│   └── superpowers/
│       ├── plans/
│       └── specs/
├── plugins/
│   └── graph-mcp/
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── .codex-plugin/
│       │   └── plugin.json
│       ├── dist/
│       │   └── graph-mcp.js
│       ├── skills/
│       │   └── setup/
│       │       └── SKILL.md
│       ├── .mcp.json
│       ├── LICENSE
│       └── README.md
├── scripts/
│   ├── build-plugin.mjs
│   └── verify-plugin-versions.mjs
├── src/
│   ├── auth/
│   │   ├── auth-manager.ts
│   │   ├── browser-flow.ts
│   │   └── device-code-flow.ts
│   ├── tools/
│   │   ├── auth-tools.ts
│   │   ├── calendar-tools.ts
│   │   ├── chat-tools.ts
│   │   ├── files-tools.ts
│   │   ├── mail-tools.ts
│   │   ├── meeting-tools.ts
│   │   ├── message-tools.ts
│   │   ├── presence-tools.ts
│   │   ├── profile-tools.ts
│   │   ├── search-tools.ts
│   │   ├── teams-tools.ts
│   │   └── user-tools.ts
│   ├── cli.ts
│   ├── config.ts
│   ├── errors.ts
│   ├── graph-client.ts
│   ├── rate-limiter.ts
│   ├── responses.ts
│   ├── server.ts
│   └── token-store.ts
├── tests/
│   ├── auth/
│   ├── tools/
│   ├── graph-client.test.ts
│   ├── mcp-stdio.test.ts
│   ├── plugin-packaging.test.ts
│   ├── rate-limiter.test.ts
│   ├── responses.test.ts
│   ├── token-store.test.ts
│   └── tool-contract.test.ts
├── LICENSE
├── README.md
├── package-lock.json
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

The npm package remains at the repository root. The distributable plugin is a generated-but-versioned artifact under `plugins/graph-mcp/`. Keeping the plugin in a dedicated directory lets both marketplace files reference the same relative path without duplicating source code or violating marketplace path containment rules.

## Runtime Architecture

### MCP server

- Use `@modelcontextprotocol/sdk` and `zod`.
- Expose a `createServer(dependencies?)` factory so tests can inject fake auth, storage, clock, sleep, browser opening, and HTTP transport.
- Use `StdioServerTransport` in the production CLI.
- Return the same serialized JSON text currently returned by FastMCP:
  - success: `{"data": ..., "message": "..."}`
  - error: `{"error": "...", "action_required": "..."}`
- Do not add a second structured output contract during the migration.

### CLI

The `graph-mcp` executable supports:

- No arguments: start the stdio MCP server.
- `setup`: prompt for Azure Client ID and optional Tenant ID, persist non-secret configuration, and print host-specific manual configuration examples.
- `--version`: print the package version.
- `--help`: print CLI usage.

The server must start even when Azure configuration is absent. Authentication tools remain available and return actionable setup guidance instead of causing the MCP process to exit before tools are discovered.

### Configuration

Configuration precedence is:

1. Environment variables.
2. `~/.graph-mcp/config.json`.
3. Documented defaults.

Supported environment variables remain:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `GRAPH_REDIRECT_URI`
- `GRAPH_TOKEN_ENCRYPTION_KEY`
- `GRAPH_TOKEN_REFRESH_BUFFER`
- `GRAPH_RATE_LIMIT_MAX_REQUESTS`
- `GRAPH_RATE_LIMIT_WINDOW`
- `GRAPH_DEBUG`

The config directory is created with mode `0700`. Configuration and token files use mode `0600` where the operating system supports POSIX permissions.

## Authentication

### Browser flow

The no-argument `graph_auth_login` behavior remains browser-based OAuth2 Authorization Code with PKCE:

1. Generate a code verifier, S256 challenge, and CSRF state.
2. Start a one-request localhost callback listener.
3. Open the system browser.
4. Validate callback path and state.
5. Exchange the authorization code.
6. encrypt and persist the token response.

The listener always closes on success, OAuth error, timeout, or cancellation.

### Device-code flow

`graph_auth_login` gains one optional argument:

```text
method: "browser" | "device_code" = "browser"
```

This is backward-compatible because existing empty-argument calls continue using browser login.

For `device_code`:

1. Request a device code from Microsoft.
2. Return the verification URL, user code, expiry, and Microsoft-provided message immediately.
3. Poll the token endpoint in a managed background task.
4. Handle `authorization_pending`, `slow_down`, expiry, and cancellation.
5. Store tokens on success.
6. Let `graph_auth_status` report pending, authenticated, failed, or expired state.

Only one login flow may be active at a time.

### Token storage

- Use AES-256-GCM from Node's built-in `crypto` module.
- Store Node credentials in versioned files such as `tokens-v2.enc` and `.key-v2`.
- Never overwrite the existing Python Fernet files during migration.
- Use `GRAPH_TOKEN_ENCRYPTION_KEY` when provided; otherwise generate a local 256-bit key.
- Serialize writes through an in-process lock and use atomic temporary-file rename.
- Clear token data after a failed refresh that proves the refresh token is invalid.
- Document that users authenticate once after moving from Python to Node.

## Microsoft Graph Client

- Use native `fetch` with a 30-second abort timeout.
- Build requests against `https://graph.microsoft.com/v1.0`.
- Acquire the sliding-window rate-limit slot before authentication and request dispatch, matching current behavior.
- On HTTP 429:
  - Honor `Retry-After` when present.
  - Otherwise use capped exponential backoff.
  - Retry once.
- On HTTP 401:
  - Refresh the access token under a single-flight lock.
  - Retry once.
- Parse JSON when the content type is JSON.
- Return text for transcript and file-content responses.
- Return `null` for HTTP 204 or empty bodies.
- Convert Graph error payloads into the existing `Graph API error: <status>: <message>` response shape.

The Graph client accepts injected `fetch`, clock, and sleep functions so retry behavior can be tested without live network calls or real delays.

## Tool Migration Rules

- Each Python tool module maps to one TypeScript tool module.
- Tool names remain unchanged.
- Required parameters remain required.
- Optional parameters and defaults remain unchanged.
- Existing maximum values such as `top <= 25` or `top <= 50` remain unchanged.
- HTML and plain-text message bodies are passed through without Markdown conversion.
- Mention normalization accepts both raw Graph mention objects and the existing simplified shapes.
- Select-field constants remain centralized.
- Existing Graph resource paths and query options remain unchanged unless a parity test demonstrates that the Python implementation cannot work as documented.
- The tool contract test contains the complete expected inventory and input schemas so accidental renames or drift fail CI.

## Plugin Packaging

### Shared plugin payload

The generated plugin directory contains the compiled single-file runtime. Its `.mcp.json` starts the server with Node and a plugin-root-relative bundle path:

```json
{
  "mcpServers": {
    "graph": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/graph-mcp.js"]
    }
  }
}
```

The implementation will verify this path substitution against the installed Claude Code and Codex plugin runtimes. If a host changes its accepted compatibility variable, the build script will generate host-specific MCP config files while keeping one runtime bundle.

### Claude Code

- Manifest: `plugins/graph-mcp/.claude-plugin/plugin.json`
- Marketplace: `.claude-plugin/marketplace.json`
- Marketplace source: `./plugins/graph-mcp`
- Plugin root includes `.mcp.json` and `skills/setup/SKILL.md`.
- Validation: `claude plugin validate --strict .`
- Local installation is tested from an isolated temporary Claude configuration directory.

### Codex

- Manifest: `plugins/graph-mcp/.codex-plugin/plugin.json`
- Marketplace: `.agents/plugins/marketplace.json`
- Marketplace source: `./plugins/graph-mcp`
- Marketplace entries include installation policy, authentication policy, and category.
- The manifest includes the required interface metadata and points to the shared MCP config and setup skill.
- Validation uses the official plugin-creator validator and an isolated Codex marketplace install.

### Setup skill

The plugin includes a small, host-neutral setup skill that:

- Explains the Azure public-client app registration.
- Lists exact delegated Microsoft Graph permissions.
- Directs the user to run the bundled `setup` command or set environment variables.
- Explains browser and device-code login.
- Warns users that Graph data is passed to the invoking model and remains subject to organizational policy.
- Never asks the agent to collect or persist secrets in conversation.

### Build and version synchronization

`npm run build`:

1. Type-checks the source.
2. Bundles the runtime into root `dist/`.
3. Copies the executable bundle into `plugins/graph-mcp/dist/`.
4. Copies the license and plugin README.
5. Verifies that the package, Claude manifest, and Codex manifest versions agree.

The bundled plugin artifact is committed so Git-based marketplace installation does not require a build step.

Marketplace entries omit their own version when the host permits it. The plugin manifests are the version authority, avoiding a stale marketplace version masking an updated plugin.

## npm Distribution

- Package name: `graph-mcp`.
- Version: `0.6.0`.
- Module format: ESM.
- Engine: Node.js `>=22`.
- Binary: `graph-mcp`.
- Published files include the compiled runtime, README, LICENSE, and package metadata.
- `prepublishOnly` runs formatting checks, linting, type-checking, tests, build, and package-content verification using repository-owned tooling.
- Host-specific plugin validation remains a separate release gate because the Claude and Codex validators are external tools rather than npm development dependencies.

Publishing itself is outside implementation scope because it requires registry credentials and an explicit external release action.

## Error Handling and Security

- Write diagnostics only to stderr so stdout remains valid MCP protocol traffic.
- Redact access tokens, refresh tokens, authorization codes, PKCE verifiers, and encryption keys from logs and returned errors.
- Do not accept client secrets.
- Validate OAuth state and callback path.
- Bind the callback server only to loopback.
- Validate and cap user-provided `top` values as the current tools do.
- Preserve Graph API errors without including request authorization headers.
- Decode file uploads strictly as base64 and retain the 4 MiB limit.
- Use atomic token writes and restrictive permissions.
- Avoid shell interpolation in the MCP launcher configuration.

## Testing Strategy

### Unit tests

- Response serialization and error wrapping.
- Rich-text and mention payload construction.
- Configuration precedence and type coercion.
- PKCE generation and authorization URL construction.
- Browser callback success, CSRF rejection, OAuth error, and timeout.
- Device-code pending, slow-down, success, rejection, and expiry.
- Token encryption, loading, atomic persistence, permissions, expiry, and clearing.
- Rate-limit window and exponential backoff.
- Graph client success, 204, text, 400, 401 refresh, 429 retry, timeout, and malformed payloads.
- Request construction for all tool modules.

### Contract tests

- Exactly 44 tools are registered.
- The full expected tool-name set matches.
- Required versus optional parameters match the Python source.
- Default values match the Python source.
- Tool handlers return the existing JSON text envelope.

### Integration tests

- Spawn the compiled server over stdio.
- Initialize an MCP client.
- List tools and verify the 44-tool inventory.
- Call authentication status without configuration and receive actionable output.
- Call representative tools using injected fake Graph responses.
- Ensure stdout contains only MCP protocol frames.

### Packaging tests

- Build the npm package and inspect `npm pack --dry-run`.
- Assert required plugin files exist in the packed or generated artifact.
- Validate Claude plugin and marketplace metadata in strict mode.
- Validate Codex plugin metadata with the official validator.
- Install each marketplace under isolated temporary host configuration.
- Start the MCP server through the installed plugin path and list all tools.
- Verify package and manifest versions stay synchronized.

### Baseline

Before migration, the original Python project passes its four existing message-formatting tests. Those cases are carried forward and expanded in TypeScript.

## Documentation Changes

The root README will:

- State that the server is implemented in Node.js.
- Correct the tool count to 44.
- Provide plugin installation instructions for Claude Code and Codex.
- Provide npm installation and source-development instructions.
- Keep the Azure app registration and delegated permission list.
- Document browser and device-code authentication.
- Explain the one-time reauthentication after migration.
- Document configuration precedence and token locations.
- Preserve the data-handling disclaimer.

The plugin README contains concise installation and first-run instructions, while the root README retains full development and architecture documentation.

## Migration and Compatibility

- Remove the Python package metadata, Python source, and Python tests only after equivalent TypeScript contract and behavior tests exist and pass.
- Keep the same project and executable name.
- Release as version 0.6.0 to communicate a runtime migration while retaining the pre-1.0 compatibility policy.
- Existing MCP configurations that invoke `graph-mcp` continue to work after the npm binary is installed.
- Existing environment-variable configuration continues to work.
- Existing encrypted Python tokens remain untouched but are not imported; users log in once.
- Plugin installations run the committed bundle directly and do not depend on npm publication.

## Acceptance Criteria

The migration is complete only when all of the following are proven:

1. The repository no longer requires Python to build, test, or run Graph MCP.
2. The Node stdio server exposes exactly the 44 authoritative tools.
3. Tool names, existing parameters, defaults, response envelopes, Graph paths, and scopes match the Python implementation; the only additive schema change is `graph_auth_login.method`.
4. Browser PKCE login, device-code login, refresh, logout, and encrypted persistence are covered by passing tests.
5. Graph retry, rate-limit, timeout, JSON, text, and error behavior are covered by passing tests.
6. The compiled npm binary starts and completes an MCP initialize/list-tools smoke test.
7. The generated plugin contains the compiled runtime and requires no install-time dependency step.
8. Claude's strict validator passes for the plugin and marketplace.
9. Codex's official plugin validator passes.
10. Isolated local installation and MCP startup succeed for both plugin hosts.
11. `npm test`, lint, type-check, build, and package verification pass from a clean checkout.
12. Installation, configuration, migration, security, and release documentation is complete.

## Official Packaging References

- [Build Codex plugins](https://developers.openai.com/codex/plugins/build)
- [Codex Model Context Protocol](https://developers.openai.com/codex/mcp)
- [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
