---
name: setup
description: Use when configuring Graph MCP for Microsoft Graph access or troubleshooting Azure app registration and first login.
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

Run the bundled setup command from the installed plugin root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/graph-mcp.js" setup
```

The setup command only persists the Client ID and Tenant ID; it does not perform login.
After setup, `graph_auth_login` uses browser login by default. Set `method: "device_code"`
when a browser or loopback callback is unavailable; `method: "device_code"` is the fallback.

Client ID and Tenant ID are identifiers, not secrets. Never request or store a client secret, access token, refresh token, authorization code, MFA code, or credentials in conversation.

Tokens are encrypted locally under ~/.graph-mcp. Graph data is passed to the invoking model and is subject to BP/organizational policy. Use least privilege and obtain admin consent where required by your organization.
