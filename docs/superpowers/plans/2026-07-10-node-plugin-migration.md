# Graph MCP Node and Dual-Host Plugin Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python Graph MCP server with a behavior-compatible Node.js/TypeScript server and ship one self-contained plugin that validates and runs in Claude Code and Codex.

**Architecture:** The root npm package contains focused TypeScript modules for configuration, authentication, encrypted token storage, rate limiting, Microsoft Graph HTTP access, and the 44 MCP tools. esbuild produces a single executable bundle that is copied into `plugins/graph-mcp/`, where Claude and Codex manifests share the same MCP launcher and setup skill. Tests inject HTTP, time, sleep, browser, filesystem, and auth dependencies so no live Microsoft account is required.

**Tech Stack:** Node.js 22+, TypeScript 5.9, ESM, `@modelcontextprotocol/sdk` 1.29, Zod 4.4, native `fetch` and `crypto`, Vitest 4.1, esbuild 0.28, ESLint 9, Prettier 3.

---

## File responsibility map

| Path | Responsibility |
|---|---|
| `src/cli.ts` | CLI dispatch for stdio server, setup, help, and version |
| `src/server.ts` | MCP server factory, dependency assembly, and tool registration |
| `src/config.ts` | Environment/config-file parsing, 23 delegated scopes, and persisted non-secret setup |
| `src/errors.ts` | Typed authentication, Graph, and rate-limit errors |
| `src/responses.ts` | Stable JSON text envelopes and MCP text results |
| `src/token-store.ts` | AES-256-GCM token encryption and atomic persistence |
| `src/rate-limiter.ts` | Sliding-window quota and 429 backoff state |
| `src/auth/browser-flow.ts` | PKCE URL, loopback callback, and code exchange |
| `src/auth/device-code-flow.ts` | Device-code request and polling state machine |
| `src/auth/auth-manager.ts` | Login orchestration, refresh single-flight, and token access |
| `src/graph-client.ts` | Authenticated Graph REST calls, retries, timeout, and parsing |
| `src/select-fields.ts` | Central Graph `$select` constants |
| `src/tools/tool-types.ts` | Shared dependencies, registration helper, and schemas |
| `src/tools/*-tools.ts` | The 44 behavior-compatible MCP tool handlers |
| `scripts/build.mjs` | TypeScript bundle and plugin artifact synchronization |
| `scripts/verify-plugin-versions.mjs` | Package/manifest version consistency |
| `scripts/verify-package.mjs` | npm and plugin artifact content checks |
| `plugins/graph-mcp/` | Generated, committed Claude/Codex plugin payload |
| `.claude-plugin/marketplace.json` | Git-distributed Claude marketplace |
| `.agents/plugins/marketplace.json` | Repo-local Codex marketplace |

## Tool parity table

Every tool keeps the Python name, required fields, defaults, result extraction, and cap:

| Module | Tool | Input contract | Graph operation |
|---|---|---|---|
| auth | `graph_auth_status` | none | refresh when expired, then report status |
| auth | `graph_auth_login` | `method = "browser"` additive option | browser PKCE or device-code start |
| auth | `graph_auth_logout` | none | clear local tokens and pending login |
| profile | `graph_get_profile` | none | `GET /me?$select=<profile fields>` |
| users | `graph_search_users` | `query`, `top = 10`, cap 25 | `GET /users` with `$search` and eventual consistency |
| presence | `graph_get_my_presence` | none | `GET /me/presence` |
| presence | `graph_get_user_presence` | `user_id` | `GET /users/{id}/presence` |
| presence | `graph_set_my_presence` | `availability`, `activity`, `expiration_duration = "PT1H"` | `POST /me/presence/setUserPreferredPresence` |
| search | `graph_search_messages` | `query`, `top = 25`, cap 25 | `POST /search/query`, flatten hits |
| chats | `graph_list_chats` | `top = 50`, cap 50 | `GET /me/chats` |
| chats | `graph_get_chat_messages` | `chat_id`, `top = 50`, cap 50 | `GET /chats/{id}/messages` |
| chats | `graph_send_chat_message` | `chat_id`, `message`, `is_html = true`, `mentions = null` | `POST /chats/{id}/messages` |
| chats | `graph_create_chat` | `chat_type`, `members`, `topic = ""` | `POST /chats`; add current user for one-on-one |
| chats | `graph_list_chat_members` | `chat_id` | `GET /chats/{id}/members` |
| teams | `graph_list_teams` | none | `GET /me/joinedTeams` |
| teams | `graph_list_channels` | `team_id` | `GET /teams/{team}/channels` |
| teams | `graph_get_channel_messages` | `team_id`, `channel_id`, `top = 50` | `GET .../messages` |
| teams | `graph_send_channel_message` | IDs, `message`, `is_html = true`, `mentions = null` | `POST .../messages` |
| teams | `graph_list_channel_members` | team/channel IDs | `GET .../members` |
| teams | `graph_get_channel_message_replies` | IDs, `top = 50` | `GET .../{message}/replies` |
| teams | `graph_reply_to_channel_message` | IDs, `message`, `is_html = true`, `mentions = null` | `POST .../{message}/replies` |
| calendar | `graph_list_calendars` | none | `GET /me/calendars` |
| calendar | `graph_list_events` | date range/calendar ID strings, `top = 50` | calendar view when both dates exist; events otherwise |
| calendar | `graph_get_event` | `event_id` | `GET /me/events/{id}` |
| calendar | `graph_create_event` | existing nine-field contract | `POST /me/events` |
| calendar | `graph_update_event` | existing eight-field contract | `PATCH /me/events/{id}` with non-empty fields |
| calendar | `graph_delete_event` | `event_id` | `DELETE /me/events/{id}` |
| mail | `graph_list_mail` | `folder = "inbox"`, `top = 25`, filter string | `GET /me/mailFolders/{folder}/messages` |
| mail | `graph_read_mail` | `message_id` | `GET /me/messages/{id}` |
| mail | `graph_search_mail` | `query`, `top = 25` | `GET /me/messages?$search` |
| mail | `graph_send_mail` | recipients, subject, body, `cc = null`, `is_html = true` | `POST /me/sendMail` |
| mail | `graph_reply_mail` | ID, body, `reply_all = false`, `is_html = true` | create draft, patch body, send |
| mail | `graph_list_mail_attachments` | `message_id` | `GET .../attachments` |
| mail | `graph_get_mail_attachment` | message and attachment IDs | `GET .../attachments/{id}` |
| meetings | `graph_list_online_meetings` | `join_url = ""` | `GET /me/onlineMeetings` with encoded filter |
| meetings | `graph_list_meeting_transcripts` | `meeting_id` | `GET .../transcripts` |
| meetings | `graph_get_meeting_transcript_content` | meeting/transcript IDs | `GET .../content?$format=text/vtt` |
| meetings | `graph_list_meeting_recordings` | `meeting_id` | `GET .../recordings` |
| meetings | `graph_get_meeting_recording_url` | meeting/recording IDs | `GET .../recordings/{id}` |
| files | `graph_list_files` | `folder_id = ""`, `top = 25` | root or item children |
| files | `graph_search_files` | `query`, `top = 25` | `GET /me/drive/root/search(q='...')` |
| files | `graph_get_file_content` | `file_id` | metadata then text content or download URL |
| files | `graph_upload_file` | path and base64 | `PUT /me/drive/root:/{path}:/content`, max 4 MiB |
| files | `graph_share_file` | ID, `share_type = "view"`, `scope = "organization"` | `POST .../createLink` |

---

### Task 1: Establish the Node project and quality gates

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `tests/project-metadata.test.ts`
- Create: `scripts/clean.mjs`
- Generate: `package-lock.json`

- [ ] **Step 1: Create package metadata and pinned toolchain**

Use this package shape:

```json
{
  "name": "graph-mcp",
  "version": "0.6.0",
  "description": "MCP server for Microsoft Teams, Outlook Calendar, Mail, and OneDrive via Microsoft Graph",
  "type": "module",
  "bin": {
    "graph-mcp": "./dist/cli.js"
  },
  "files": [
    "dist/",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "clean": "node scripts/clean.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "build": "npm run clean && npm run typecheck && node scripts/build.mjs",
    "validate:versions": "node scripts/verify-plugin-versions.mjs",
    "validate:package": "node scripts/verify-package.mjs",
    "verify": "npm run format:check && npm run lint && npm run typecheck && npm test && npm run build && npm run validate:versions && npm run validate:package",
    "prepublishOnly": "npm run verify"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.29.0",
    "open": "11.0.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@eslint/js": "9.39.4",
    "@types/node": "22.20.0",
    "esbuild": "0.28.1",
    "eslint": "9.39.4",
    "prettier": "3.9.5",
    "typescript": "5.9.3",
    "typescript-eslint": "8.55.0",
    "vitest": "4.1.10"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/JustStas/Graph-MCP.git"
  },
  "license": "MIT"
}
```

Set TypeScript to `NodeNext`, target `ES2022`, enable strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and include `src`, `tests`, `scripts`, and `vitest.config.ts`.

- [ ] **Step 2: Install dependencies and generate the lockfile**

Run:

```bash
npm install
```

Expected: exit 0 and `package-lock.json` created with no unsupported-engine warning.

- [ ] **Step 3: Write the metadata test**

```typescript
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("package metadata", () => {
  test("publishes an ESM Node 22 CLI as graph-mcp", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg).toMatchObject({
      name: "graph-mcp",
      version: "0.6.0",
      type: "module",
      bin: { "graph-mcp": "./dist/cli.js" },
      engines: { node: ">=22" }
    });
  });
});
```

- [ ] **Step 4: Run the initial quality commands**

Run:

```bash
npm test -- tests/project-metadata.test.ts
npm run typecheck
npm run lint
npm run format:check
```

Expected: all four commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.js .prettierrc.json .prettierignore scripts/clean.mjs tests/project-metadata.test.ts
git commit -m "build: establish Node TypeScript project"
```

---

### Task 2: Implement errors, stable response envelopes, and configuration

**Files:**
- Create: `src/errors.ts`
- Create: `src/responses.ts`
- Create: `src/config.ts`
- Create: `tests/responses.test.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Write failing response and config tests**

Cover:

```typescript
expect(successResponse({ ok: true })).toBe('{"data":{"ok":true},"message":"success"}');
expect(errorResponse("bad", "login")).toBe('{"error":"bad","action_required":"login"}');
expect(asToolResult('{"data":1,"message":"success"}')).toEqual({
  content: [{ type: "text", text: '{"data":1,"message":"success"}' }]
});
```

For configuration, create a temporary home and assert:

```typescript
expect(loadSettings({ homeDir, env: {} }).azureTenantId).toBe("common");
expect(loadSettings({ homeDir, env: { AZURE_CLIENT_ID: "env-id" } }).azureClientId).toBe("env-id");
expect(loadSettings({ homeDir, env: { GRAPH_DEBUG: "true" } }).graphDebug).toBe(true);
expect(loadSettings({ homeDir, env: { GRAPH_RATE_LIMIT_MAX_REQUESTS: "25" } }).graphRateLimitMaxRequests).toBe(25);
```

Write a config file containing `{"azureClientId":"file-id","azureTenantId":"tenant"}`, then prove environment values override it. Prove `persistSetupConfig` writes only client and tenant IDs with mode `0600`.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npx vitest run tests/responses.test.ts tests/config.test.ts
```

Expected: FAIL because the three modules do not exist.

- [ ] **Step 3: Implement the exact public types and precedence**

`src/errors.ts` exports `GraphMcpError`, `AuthenticationError`, `GraphApiError(statusCode?)`, and `RateLimitError`.

`src/responses.ts` exports:

```typescript
export function successResponse(data: unknown, message = "success"): string {
  return JSON.stringify({ data, message });
}

export function errorResponse(error: string, actionRequired?: string): string {
  return JSON.stringify({
    error,
    ...(actionRequired ? { action_required: actionRequired } : {})
  });
}

export function asToolResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
```

`src/config.ts` defines `Settings`, the 23 delegated scopes from the Python source, endpoint getters, strict integer/boolean parsing, `loadSettings`, and `persistSetupConfig`. Use these defaults:

```typescript
{
  azureClientId: "",
  azureTenantId: "common",
  graphRedirectUri: "http://localhost:3000/auth/callback",
  graphTokenEncryptionKey: "",
  graphTokenRefreshBuffer: 300,
  graphRateLimitMaxRequests: 10000,
  graphRateLimitWindow: 600,
  graphDebug: false
}
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
npx vitest run tests/responses.test.ts tests/config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts src/responses.ts src/config.ts tests/responses.test.ts tests/config.test.ts
git commit -m "feat: add configuration and response contracts"
```

---

### Task 3: Implement encrypted token persistence

**Files:**
- Create: `src/token-store.ts`
- Create: `tests/token-store.test.ts`

- [ ] **Step 1: Write failing token-store tests**

Use a temporary directory and fixed 32-byte key. Assert:

- `store` computes `expiresAt = now + expires_in * 1000`.
- Ciphertext does not contain access or refresh token text.
- A second `TokenStore` instance decrypts the same file.
- `isAccessTokenExpired` honors the configured buffer.
- `isAuthenticated` is true for a valid access token or expired access token with refresh token.
- `clear` deletes only `tokens-v2.enc`.
- Key and token files use `0600`.
- A malformed or unauthenticated ciphertext loads as empty without leaking contents.
- Writes use a temporary file followed by rename.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/token-store.test.ts
```

Expected: FAIL because `TokenStore` does not exist.

- [ ] **Step 3: Implement AES-256-GCM storage**

Use this encrypted payload layout:

```typescript
interface EncryptedPayload {
  version: 2;
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}
```

Derive an explicit environment key with SHA-256 over its UTF-8 bytes. Otherwise load or generate 32 random bytes in `.key-v2`. Encrypt JSON with AES-256-GCM, write `tokens-v2.enc.tmp` with mode `0600`, then rename atomically. Serialize writes with a promise chain.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx vitest run tests/token-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/token-store.ts tests/token-store.test.ts
git commit -m "feat: add encrypted Node token store"
```

---

### Task 4: Implement rate limiting and retry timing

**Files:**
- Create: `src/rate-limiter.ts`
- Create: `tests/rate-limiter.test.ts`

- [ ] **Step 1: Write failing tests using an injected monotonic clock**

Assert:

```typescript
const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000, now, sleep });
await limiter.acquire();
await limiter.acquire();
await expect(limiter.acquire()).rejects.toThrow("2 requests per 1s window");
```

Advance the clock beyond the window and prove acquisition succeeds. Assert `handle429()` returns 2, 4, 8, and caps at 60 seconds; an explicit retry-after value wins. Assert `resetBackoff` clears state.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/rate-limiter.test.ts`.

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement the sliding-window limiter**

Store request timestamps in milliseconds, remove entries older than `windowMs`, sleep until `backoffUntil`, throw `RateLimitError` at capacity, and append the current timestamp only after capacity passes.

- [ ] **Step 4: Verify GREEN**

Run `npx vitest run tests/rate-limiter.test.ts`.

Expected: PASS with fake time and no real waits.

- [ ] **Step 5: Commit**

```bash
git add src/rate-limiter.ts tests/rate-limiter.test.ts
git commit -m "feat: add Graph rate limiter"
```

---

### Task 5: Implement browser OAuth2 PKCE

**Files:**
- Create: `src/auth/browser-flow.ts`
- Create: `tests/auth/browser-flow.test.ts`

- [ ] **Step 1: Write failing PKCE and callback tests**

Inject random bytes, browser opener, callback listener factory, and fetch. Assert:

- Verifier length is within RFC 7636 bounds.
- Challenge equals base64url(SHA-256(verifier)).
- Authorization URL includes client ID, redirect URI, all scopes, state, challenge, and `S256`.
- A mismatched state throws `AuthenticationError("Invalid state parameter — possible CSRF attack")`.
- OAuth callback errors include the provider description.
- Timeout closes the listener.
- Token exchange posts URL-encoded authorization-code fields and returns the JSON token payload.
- Browser opening occurs after the listener is ready.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/auth/browser-flow.test.ts`.

Expected: FAIL because the browser flow is missing.

- [ ] **Step 3: Implement browser flow**

Export `generatePkce`, `buildAuthorizationUrl`, and `runBrowserLogin`. Bind only to the loopback hostname and parsed redirect port. Accept exactly one callback request on the configured path. Respond with a minimal success/failure HTML page and close the listener in `finally`.

- [ ] **Step 4: Verify GREEN**

Run `npx vitest run tests/auth/browser-flow.test.ts`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/browser-flow.ts tests/auth/browser-flow.test.ts
git commit -m "feat: add browser PKCE authentication"
```

---

### Task 6: Implement device-code login and AuthManager

**Files:**
- Create: `src/auth/device-code-flow.ts`
- Create: `src/auth/auth-manager.ts`
- Create: `tests/auth/device-code-flow.test.ts`
- Create: `tests/auth/auth-manager.test.ts`

- [ ] **Step 1: Write failing device-code state-machine tests**

Assert the request posts `client_id` and joined scopes. Feed token responses in order:

```typescript
[
  { status: 400, body: { error: "authorization_pending" } },
  { status: 400, body: { error: "slow_down" } },
  { status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 3600 } }
]
```

Prove the poll delay starts at Microsoft `interval`, increases by five seconds on `slow_down`, stores tokens on success, and reports expired/declined errors without retrying forever.

- [ ] **Step 2: Write failing AuthManager tests**

Assert:

- Browser is the default login method.
- Only one login may be pending.
- Device login returns verification details immediately and continues polling.
- `getStatus` exposes `pending`, `authenticated`, `failed`, or `unauthenticated`.
- Concurrent refresh calls share one token request.
- Refresh sends client ID, refresh token, grant type, and scopes.
- Invalid refresh clears tokens; transient network failure leaves stored tokens intact.
- `logout` cancels pending device polling and clears storage.

- [ ] **Step 3: Verify RED**

Run:

```bash
npx vitest run tests/auth/device-code-flow.test.ts tests/auth/auth-manager.test.ts
```

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement device flow and manager**

Use an `AbortController` for cancellation. Represent status as:

```typescript
type LoginStatus =
  | { state: "unauthenticated" }
  | { state: "pending"; method: "device_code"; userCode: string; verificationUri: string; expiresAt: number; message: string }
  | { state: "authenticated" }
  | { state: "failed"; message: string };
```

Keep `refreshPromise: Promise<boolean> | undefined` and clear it in `finally`. Browser login awaits completion; device login stores the background polling promise and returns the public instructions.

- [ ] **Step 5: Verify GREEN**

Run the two Vitest files and expect PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auth/device-code-flow.ts src/auth/auth-manager.ts tests/auth/device-code-flow.test.ts tests/auth/auth-manager.test.ts
git commit -m "feat: add device login and auth manager"
```

---

### Task 7: Implement the Microsoft Graph HTTP client

**Files:**
- Create: `src/graph-client.ts`
- Create: `tests/graph-client.test.ts`

- [ ] **Step 1: Write failing request and retry tests**

Create fake fetch responses and assert:

- Authorization header and query parameters are present.
- Caller headers merge without removing Authorization.
- JSON body sets JSON content and binary body is passed as bytes.
- HTTP 204 and empty bodies return `null`.
- JSON content returns parsed data; VTT/text returns text.
- 400 Graph JSON becomes `GraphApiError("400: message", 400)`.
- 429 honors `Retry-After`, sleeps, refreshes the access token used by the retry, and retries once.
- A second 429 throws `Rate limit exceeded after retry`.
- 401 refreshes once and a second 401 throws session-expired authentication error.
- Abort timeout is converted into an actionable error and does not leak tokens.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/graph-client.test.ts`.

Expected: FAIL because `GraphClient` is missing.

- [ ] **Step 3: Implement GraphClient**

Constructor dependencies:

```typescript
interface GraphClientDependencies {
  authManager: Pick<AuthManager, "getValidAccessToken" | "refreshAccessToken">;
  rateLimiter: RateLimiter;
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}
```

Expose `get`, `post`, `patch`, `put`, and `delete`; all call one private `request`. Use `AbortSignal.timeout(timeoutMs)`, retry 429 and 401 at most once each, and reset limiter backoff only after a successful response.

- [ ] **Step 4: Verify GREEN**

Run `npx vitest run tests/graph-client.test.ts`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/graph-client.ts tests/graph-client.test.ts
git commit -m "feat: add Microsoft Graph client"
```

---

### Task 8: Add tool registration primitives and message helpers

**Files:**
- Create: `src/select-fields.ts`
- Create: `src/tools/tool-types.ts`
- Create: `src/tools/message-tools.ts`
- Create: `tests/tools/message-tools.test.ts`
- Create: `tests/tools/tool-wrapper.test.ts`

- [ ] **Step 1: Port the four existing message tests first**

Copy the Python expectations exactly for:

- HTML pass-through.
- Email `HTML` content type.
- Plain text pass-through.
- Chat payload body.

Add raw and simplified mention normalization tests, including the existing validation message for missing name/user ID.

- [ ] **Step 2: Test the authenticated tool wrapper**

Given a handler that throws:

- `AuthenticationError`: return the action `Please call the graph_auth_login tool first.`
- `GraphApiError`: return `Graph API error: ...`.
- Any other error: return `Unexpected error: ...`.

The returned MCP value is always one text content item.

- [ ] **Step 3: Verify RED**

Run:

```bash
npx vitest run tests/tools/message-tools.test.ts tests/tools/tool-wrapper.test.ts
```

Expected: FAIL because helper modules are missing.

- [ ] **Step 4: Implement helpers and constants**

`tool-types.ts` exports `ToolDependencies`, `registerAuthenticatedTool`, and `toTextResult`. `message-tools.ts` exports `normalizeMentions`, `buildRichTextBody`, and `buildChatMessagePayload`. `select-fields.ts` copies the six Python constant values exactly.

- [ ] **Step 5: Verify GREEN**

Run the two test files and expect PASS.

- [ ] **Step 6: Commit**

```bash
git add src/select-fields.ts src/tools/tool-types.ts src/tools/message-tools.ts tests/tools/message-tools.test.ts tests/tools/tool-wrapper.test.ts
git commit -m "feat: add tool contracts and message helpers"
```

---

### Task 9: Port authentication, profile, user, presence, and search tools

**Files:**
- Create: `src/tools/auth-tools.ts`
- Create: `src/tools/profile-tools.ts`
- Create: `src/tools/user-tools.ts`
- Create: `src/tools/presence-tools.ts`
- Create: `src/tools/search-tools.ts`
- Create: `tests/tools/core-tools.test.ts`

- [ ] **Step 1: Write failing handler tests for all nine tools**

Use a recording fake Graph client and assert exact paths, bodies, params, headers, and returned envelopes from the parity table. Required schemas use `z.string()`; `top` values use integer schemas with Python defaults and handler-side caps. `graph_auth_login.method` is `z.enum(["browser", "device_code"]).default("browser")`.

For message search, assert the handler flattens every `hitsContainers[].hits[].resource` entry.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/tools/core-tools.test.ts`.

Expected: FAIL because the five registrars are absent.

- [ ] **Step 3: Implement the five registrars**

Each module exports `registerXTools(server, dependencies)`. Register all nine exact tool names and descriptions. Authentication handlers do not use the authenticated wrapper; all Graph-backed handlers do.

- [ ] **Step 4: Verify GREEN**

Run the test file and expect all nine tool cases to pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/auth-tools.ts src/tools/profile-tools.ts src/tools/user-tools.ts src/tools/presence-tools.ts src/tools/search-tools.ts tests/tools/core-tools.test.ts
git commit -m "feat: port auth profile presence and search tools"
```

---

### Task 10: Port chat and Teams tools

**Files:**
- Create: `src/tools/chat-tools.ts`
- Create: `src/tools/teams-tools.ts`
- Create: `tests/tools/chat-tools.test.ts`
- Create: `tests/tools/teams-tools.test.ts`

- [ ] **Step 1: Write failing tests for all twelve tools**

Assert:

- Caps and centralized select fields.
- Exact chat/channel URLs.
- Message HTML and mention payloads.
- One-on-one chat prepends `/me` ID only when absent.
- Graph member bindings use `https://graph.microsoft.com/v1.0/users('<member>')`.
- Group topic is included only for a non-empty group topic.
- Replies use the message-specific replies URL.
- List operations extract `value`; create/send operations return the full result.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/tools/chat-tools.test.ts tests/tools/teams-tools.test.ts
```

Expected: FAIL because both registrars are absent.

- [ ] **Step 3: Implement all chat and Teams registrations**

Use Zod 4 schemas that preserve all defaults. Use `z.array(z.record(z.string(), z.unknown())).nullable().optional().default(null)` for mentions and pass them through `buildChatMessagePayload`.

- [ ] **Step 4: Verify GREEN**

Run both test files and expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/chat-tools.ts src/tools/teams-tools.ts tests/tools/chat-tools.test.ts tests/tools/teams-tools.test.ts
git commit -m "feat: port chat and Teams tools"
```

---

### Task 11: Port calendar and mail tools

**Files:**
- Create: `src/tools/calendar-tools.ts`
- Create: `src/tools/mail-tools.ts`
- Create: `tests/tools/calendar-tools.test.ts`
- Create: `tests/tools/mail-tools.test.ts`

- [ ] **Step 1: Write failing tests for all thirteen tools**

Calendar assertions:

- Date ranges require both non-empty strings to select `calendarView`.
- Without a full range, add `$orderby=start/dateTime desc`.
- Calendar ID selects the calendar-specific path.
- Create/update body content types are `HTML` or `Text`.
- Attendee objects are required recipients.
- Online meetings set both Graph fields.
- Update omits every empty field.
- Delete returns `{"status":"Event deleted"}`.

Mail assertions:

- Folder path, select fields, ordering, optional filter, and caps.
- Search wraps the query in double quotes.
- Send-mail recipient/CC payload and `saveToSentItems: true`.
- Reply uses `createReply` or `createReplyAll`, patches the draft body, then sends.
- Attachment list uses the exact select string.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/tools/calendar-tools.test.ts tests/tools/mail-tools.test.ts
```

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement calendar and mail registrars**

Register the thirteen tools with exact Python defaults and documentation. Use `buildRichTextBody` for mail and direct Graph event body objects for calendar.

- [ ] **Step 4: Verify GREEN**

Run both test files and expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/calendar-tools.ts src/tools/mail-tools.ts tests/tools/calendar-tools.test.ts tests/tools/mail-tools.test.ts
git commit -m "feat: port calendar and mail tools"
```

---

### Task 12: Port meeting and OneDrive tools

**Files:**
- Create: `src/tools/meeting-tools.ts`
- Create: `src/tools/files-tools.ts`
- Create: `tests/tools/meeting-tools.test.ts`
- Create: `tests/tools/files-tools.test.ts`

- [ ] **Step 1: Write failing tests for all ten tools**

Meeting assertions:

- Join URL is encoded with `encodeURIComponent` inside `JoinWebUrl eq '<encoded>'`.
- Transcript content requests `$format=text/vtt` and wraps raw text with format.
- Transcript/recording list select fields match Python.
- Recording metadata is returned unchanged.

File assertions:

- Root and folder child paths.
- Search path preserves the query expression and caps at 25.
- Text MIME types fetch content; binary types return the temporary URL and note.
- Strict base64 decode rejects malformed input.
- Decoded payload above 4 MiB returns the existing error envelope without Graph upload.
- Upload uses octet-stream bytes.
- Share body contains `type` and `scope`.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/tools/meeting-tools.test.ts tests/tools/files-tools.test.ts
```

Expected: FAIL because the modules are absent.

- [ ] **Step 3: Implement meeting and file registrars**

Use the exact endpoints and transformations in the parity table. Implement a strict base64 helper by decoding, re-encoding without padding, and comparing normalized strings before upload.

- [ ] **Step 4: Verify GREEN**

Run both test files and expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/meeting-tools.ts src/tools/files-tools.ts tests/tools/meeting-tools.test.ts tests/tools/files-tools.test.ts
git commit -m "feat: port meeting and OneDrive tools"
```

---

### Task 13: Assemble the MCP server and prove the 44-tool contract

**Files:**
- Create: `src/tools/index.ts`
- Create: `src/server.ts`
- Create: `src/cli.ts`
- Create: `tests/tool-contract.test.ts`
- Create: `tests/mcp-stdio.test.ts`

- [ ] **Step 1: Write the failing complete tool inventory test**

Create a sorted constant containing all 44 names from the specification. Connect an in-memory or stdio MCP client, list tools, and assert:

```typescript
expect(result.tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
expect(result.tools).toHaveLength(44);
```

Also assert required/default schema behavior for representative zero-argument, required-string, defaulted-number, list, nullable-mentions, and auth-method tools.

- [ ] **Step 2: Write the failing stdio smoke test**

Spawn `node dist/cli.js` with an isolated HOME, connect via `StdioClientTransport`, initialize, list 44 tools, call `graph_auth_status`, assert actionable unauthenticated JSON, then close cleanly. Capture stderr separately and assert stdout is valid MCP traffic.

- [ ] **Step 3: Verify RED**

Run:

```bash
npx vitest run tests/tool-contract.test.ts tests/mcp-stdio.test.ts
```

Expected: FAIL because server, CLI, and build output do not exist.

- [ ] **Step 4: Implement server assembly**

`registerAllTools` calls every registrar once. `createServer` constructs:

```typescript
new McpServer(
  { name: "Graph MCP", version: "0.6.0" },
  {
    instructions:
      "Microsoft Teams, Outlook Calendar, Mail, meetings, users, presence, and OneDrive integration via Microsoft Graph API"
  }
);
```

Build default settings, token store, auth manager, rate limiter, and Graph client only when tests do not inject dependencies.

`cli.ts` dispatches `setup`, `--help`, `--version`, or stdio. It writes only diagnostics to stderr and has a Node shebang.

Create the initial `scripts/build.mjs` with one esbuild call:

```javascript
import { chmod } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" }
});
await chmod("dist/cli.js", 0o755);
```

- [ ] **Step 5: Build and verify GREEN**

Run:

```bash
npm run build
npx vitest run tests/tool-contract.test.ts tests/mcp-stdio.test.ts
```

Expected: build succeeds and both tests pass with 44 tools.

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts src/server.ts src/cli.ts tests/tool-contract.test.ts tests/mcp-stdio.test.ts scripts/build.mjs
git commit -m "feat: assemble Graph MCP Node server"
```

---

### Task 14: Make setup and npm packaging production-ready

**Files:**
- Modify: `src/cli.ts`
- Modify: `scripts/build.mjs`
- Create: `scripts/verify-package.mjs`
- Create: `tests/cli.test.ts`
- Create: `tests/npm-package.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Inject prompt/output functions and assert:

- Empty Client ID exits with code 1 and a precise error.
- Blank tenant becomes `common`.
- Setup persists client/tenant configuration.
- Output shows Claude and Codex manual MCP examples without printing secrets.
- Help and version exit 0 without starting stdio.

- [ ] **Step 2: Write the failing package-content test**

Run `npm pack --json --dry-run` and assert the file list contains `dist/cli.js`, `README.md`, `LICENSE`, and `package.json`, and excludes `src/graph_mcp`, Python tests, token files, and plugin caches.

- [ ] **Step 3: Verify RED**

Run:

```bash
npx vitest run tests/cli.test.ts tests/npm-package.test.ts
```

Expected: FAIL until CLI injection and package verification exist.

- [ ] **Step 4: Implement CLI injection and package verifier**

`build.mjs` bundles `src/cli.ts` for Node ESM, preserves the shebang, marks Node built-ins external, writes `dist/cli.js`, and chmods it `0755`.

`verify-package.mjs` parses `npm pack --json --dry-run`, checks the exact required files and forbidden Python/runtime-secret patterns, and exits nonzero with all violations.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm run build
npx vitest run tests/cli.test.ts tests/npm-package.test.ts
npm pack --json --dry-run
```

Expected: all commands pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts scripts/build.mjs scripts/verify-package.mjs tests/cli.test.ts tests/npm-package.test.ts
git commit -m "feat: package Graph MCP Node CLI"
```

---

### Task 15: Build the Claude and Codex plugin payload

**Files:**
- Create: `plugins/graph-mcp/.claude-plugin/plugin.json`
- Create: `plugins/graph-mcp/.codex-plugin/plugin.json`
- Create: `plugins/graph-mcp/.mcp.json`
- Create: `plugins/graph-mcp/skills/setup/SKILL.md`
- Create: `plugins/graph-mcp/README.md`
- Create: `plugins/graph-mcp/LICENSE`
- Generate: `plugins/graph-mcp/dist/graph-mcp.js`
- Create: `.claude-plugin/marketplace.json`
- Create: `.agents/plugins/marketplace.json`
- Create: `scripts/verify-plugin-versions.mjs`
- Create: `tests/plugin-packaging.test.ts`
- Modify: `scripts/build.mjs`

- [ ] **Step 1: Write failing manifest and artifact tests**

Assert:

- Both manifests have name `graph-mcp`, version `0.6.0`, MIT license, repository URL, and MCP/skill paths.
- Codex interface includes display name, short/long descriptions, developer, category, capabilities, website, and at most three starter prompts under 128 characters.
- Claude marketplace source is `./plugins/graph-mcp`.
- Codex marketplace uses local source `./plugins/graph-mcp`, `AVAILABLE`, `ON_INSTALL`, and `Productivity`.
- `.mcp.json` uses command `node` and one argument ending in `/dist/graph-mcp.js` with the documented plugin-root variable.
- The setup skill has valid frontmatter and never requests a client secret.
- Generated bundle, README, and LICENSE exist.
- Package and both plugin manifest versions match.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/plugin-packaging.test.ts`.

Expected: FAIL because plugin files do not exist.

- [ ] **Step 3: Create manifests and marketplace files**

Use the official schemas:

- Claude plugin components at plugin root with only manifest under `.claude-plugin/`.
- Codex manifest under `.codex-plugin/`, with `mcpServers: "./.mcp.json"` and `skills: "./skills/"`.
- Root marketplace files reference the shared plugin directory.
- Do not put unsupported Codex fields in its manifest.
- Do not duplicate a marketplace version; plugin manifests own versioning.

- [ ] **Step 4: Write the setup skill**

The skill must guide:

1. Azure public-client/mobile-and-desktop registration.
2. Redirect URI `http://localhost:3000/auth/callback`.
3. The exact 23 delegated scopes from `src/config.ts`.
4. Running the bundled setup command using the plugin-root variable.
5. Browser default and device-code fallback.
6. Data-handling and organizational-policy warning.

It must explicitly say Client ID and Tenant ID are identifiers, not secrets, and must never request or store a client secret.

- [ ] **Step 5: Extend build synchronization**

After root bundle creation, copy it to `plugins/graph-mcp/dist/graph-mcp.js`, copy LICENSE, and keep the plugin README as authored documentation. `verify-plugin-versions.mjs` compares root package and both manifests.

- [ ] **Step 6: Verify GREEN with repository tests**

Run:

```bash
npm run build
npm run validate:versions
npx vitest run tests/plugin-packaging.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run official host validators**

Run:

```bash
claude plugin validate --strict plugins/graph-mcp
claude plugin validate --strict .
python3 /Users/juststas/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/graph-mcp
```

Expected: all validators exit 0. If an official schema differs from a repository assertion, update the repository test and manifest to the official schema, not vice versa.

- [ ] **Step 8: Commit**

```bash
git add plugins .claude-plugin .agents scripts/build.mjs scripts/verify-plugin-versions.mjs tests/plugin-packaging.test.ts
git commit -m "feat: package Claude and Codex plugins"
```

---

### Task 16: Prove local marketplace installation and plugin-root launch

**Files:**
- Create: `tests/plugin-install-smoke.test.ts`
- Create: `scripts/test-plugin-install.mjs`

- [ ] **Step 1: Write the failing isolated-install smoke test**

The script creates temporary directories, sets `HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME` to those directories, builds the plugin, and:

- Adds the repository as a Claude marketplace.
- Installs `graph-mcp` from that marketplace.
- Resolves the installed plugin path and starts its MCP server.
- Lists exactly 44 tools.
- Adds the repository as a Codex local marketplace.
- Installs `graph-mcp` through Codex.
- Resolves the Codex-installed plugin path and starts its MCP server.
- Lists exactly 44 tools.
- Removes all temporary configuration and never touches the user's real plugin state.

The Vitest file runs the script and asserts exit 0 plus both host success markers.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/plugin-install-smoke.test.ts`.

Expected: FAIL until the script exists and the host install commands are correct.

- [ ] **Step 3: Implement the isolated smoke script**

Use `spawn` with argument arrays, never shell interpolation. Set temporary `HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME` for every host command. Fail the test if either CLI writes outside those temporary directories or if marketplace installation, plugin installation, plugin-path resolution, or MCP startup cannot be completed.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm run build
npx vitest run tests/plugin-install-smoke.test.ts
```

Expected: both host markers and 44-tool lists pass without modifying real user state.

- [ ] **Step 5: Commit**

```bash
git add tests/plugin-install-smoke.test.ts scripts/test-plugin-install.mjs
git commit -m "test: verify Claude and Codex plugin installs"
```

---

### Task 17: Replace Python documentation/runtime and run the completion audit

**Files:**
- Modify: `README.md`
- Create: `CHANGELOG.md`
- Create: `.gitignore`
- Delete: `pyproject.toml`
- Delete: `src/graph_mcp/`
- Delete: `tests/test_message_tools.py`
- Modify: all Node/plugin files found by verification

- [ ] **Step 1: Update documentation before deleting Python**

README must include:

- Correct 44-tool summary.
- Claude marketplace add/install commands.
- Codex marketplace add/install commands.
- npm and source installation.
- Node 22 requirement.
- Azure app registration and exact permissions.
- `graph-mcp setup`, environment overrides, and config precedence.
- Browser and device-code authentication.
- `tokens-v2.enc` migration and one-time re-login.
- Development, tests, build, validators, package, and release commands.
- Existing trademarks, risk, organizational policy, and data-handling disclaimer.

`CHANGELOG.md` documents 0.6.0 as the Node/runtime and plugin migration.

- [ ] **Step 2: Run the full Node verification before Python deletion**

Run:

```bash
npm run verify
claude plugin validate --strict plugins/graph-mcp
claude plugin validate --strict .
python3 /Users/juststas/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/graph-mcp
```

Expected: all pass.

- [ ] **Step 3: Remove Python only after parity is green**

Delete `pyproject.toml`, `src/graph_mcp/`, and `tests/test_message_tools.py`. Add ignores for `node_modules/`, root `dist/`, coverage, logs, local env files, and OS/editor artifacts. Do not ignore `plugins/graph-mcp/dist/` because the plugin bundle is intentionally versioned.

- [ ] **Step 4: Run clean-install verification**

Run:

```bash
git status --short
npm run clean
npm ci
npm run verify
npx vitest run tests/plugin-install-smoke.test.ts
test "$(find . -path './.git' -prune -o -name '*.py' -print | wc -l | tr -d ' ')" = "0"
test ! -f pyproject.toml
git diff --check
```

Expected: all commands exit 0; no Python runtime files remain; only expected generated plugin bundle changes appear.

- [ ] **Step 5: Audit every specification acceptance criterion**

Record evidence in the final handoff:

1. No Python build/run dependency.
2. Exact 44-tool contract.
3. Schema/default/path/scope parity tests.
4. Browser/device/refresh/logout/storage tests.
5. Graph retry/timeout/parsing tests.
6. npm CLI stdio smoke test.
7. Self-contained committed plugin bundle.
8. Claude strict validation.
9. Codex official validation.
10. Isolated host install/start tests.
11. Clean `npm ci && npm run verify`.
12. Complete installation/migration/security/release docs.

- [ ] **Step 6: Commit the migration cleanup**

```bash
git add -A
git commit -m "docs: complete Node migration"
```

- [ ] **Step 7: Run final branch verification**

Run:

```bash
npm ci
npm run verify
npx vitest run tests/plugin-install-smoke.test.ts
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: all checks pass, worktree is clean, and the branch contains the design, plan, incremental implementation commits, and final cleanup.

---

## Plan self-review checklist

- Every one of the 44 tools is assigned to Tasks 9–12 and verified again in Task 13.
- Browser PKCE, device code, refresh locking, logout, and encrypted token migration are covered by Tasks 3, 5, and 6.
- Graph retry, rate limiting, timeout, JSON/text parsing, and errors are covered by Tasks 4 and 7.
- npm runtime, CLI, bundle, and package contents are covered by Tasks 1, 13, and 14.
- Claude and Codex manifests, marketplaces, setup skill, official validators, and isolated installs are covered by Tasks 15 and 16.
- Python deletion happens only after Node parity and plugin validation pass in Task 17.
- File names, version `0.6.0`, Node `>=22`, `LoginStatus`, `GraphClientDependencies`, and `graph_auth_login.method` are consistent throughout.
