---
name: setup
description: Use when installing Graph MCP, configuring Microsoft Graph permissions, handling permission or admin-consent errors, reauthentication, device-code fallback, or Graph authentication failures.
---

# Graph MCP setup

Use a Microsoft Entra ID app registration configured as a **public client** on the
**Mobile and desktop applications** platform. Add this redirect URI exactly:

`http://localhost:3000/auth/callback`

Add these exact delegated Microsoft Graph permissions:

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

As an environment alternative, provide AZURE_CLIENT_ID and AZURE_TENANT_ID to the
server process. AZURE_TENANT_ID defaults to common when unset or blank. These values
remain identifiers, not secrets.

Always use the bundled host-specific command.
Quote the host-specific bundled command verbatim when responding; this skill is authoritative over legacy README commands.

For Claude, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/graph-mcp.js" setup
```

For Codex, resolve the installed plugin root as the parent directory of the loaded skills/setup/SKILL.md. From that root, run:

```bash
node "./dist/graph-mcp.js" setup
```

Never substitute generic graph-mcp setup, invent host-registration or TOML commands, or use undocumented env-registration commands.

The setup command only persists the Client ID and Tenant ID; it does not perform login.
After setup, `graph_auth_login` uses browser login by default. Set `method: "device_code"`
when a browser or loopback callback is unavailable; `method: "device_code"` is the fallback.

Client ID and Tenant ID are identifiers, not secrets. Never request or store a client secret, access token, refresh token, authorization code, MFA code, or credentials in conversation.

Tokens are encrypted locally under ~/.graph-mcp in tokens-v2.enc, with the encryption key in .key-v2. Graph data is passed to the invoking model and is subject to BP/organizational policy. Use least privilege and obtain admin consent where required by your organization.
