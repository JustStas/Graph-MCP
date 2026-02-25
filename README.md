# Graph MCP

An MCP server that connects Claude to Microsoft Teams, Outlook Calendar, and Mail through the Microsoft Graph API.

## What it does

Gives Claude access to 41 tools:

| Category | Tools |
|---|---|
| **Auth** | Check status, login (browser OAuth), logout |
| **Chats** | List chats, read/send messages, create chats, list members |
| **Teams & Channels** | List teams, list channels, read/send messages, list members, read/send replies |
| **Calendar** | List calendars, list/get events, create/update/delete events |
| **Mail** | List emails, read email, search emails, send email, reply, list/get attachments |
| **Meetings** | Find meeting by Join URL, list/get transcripts, list recordings, get recording URL |
| **Files** | Browse OneDrive folders, search files, get content, upload files, create sharing links |
| **Users** | Search organization directory |
| **Presence** | Get/set your presence, get another user's presence |
| **Search** | Search messages across all chats and channels |

## Prerequisites

You need an Azure App Registration:

1. Go to [Azure Portal](https://portal.azure.com) > App registrations > New registration
2. Set platform to **Mobile and desktop applications**
3. Set redirect URI to `http://localhost:3000/auth/callback`
4. Mark as **Public client** (no client secret needed)
5. Under API permissions, add these **delegated** permissions:

   - `offline_access`, `openid`, `profile`, `User.Read`
   - `User.ReadBasic.All`
   - `Chat.Read`, `Chat.ReadWrite`, `ChatMessage.Send`
   - `ChannelMessage.Read.All`, `ChannelMessage.Send`
   - `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMember.Read.All`
   - `Calendars.ReadWrite`
   - `Mail.Read`, `Mail.Send`
   - `Presence.Read`, `Presence.Read.All`, `Presence.ReadWrite`
   - `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All`, `OnlineMeetingRecording.Read.All`
   - `Files.ReadWrite.All`

## Install

```
pip install graph-mcp
```

Or from a cloned repo:

```
pip install -e .
```

## Setup

```
graph-mcp setup
```

This asks for your Azure Client ID and Tenant ID, then gives you the exact command:

```
claude mcp add graph -e AZURE_CLIENT_ID=your-id -e AZURE_TENANT_ID=your-tenant -- /path/to/graph-mcp
```

Paste it, start Claude Code, and ask Claude to log in. It opens your browser for OAuth sign-in — that's it.

## How it works

```
Claude Code  ──stdio──>  graph-mcp  ──HTTPS──>  Microsoft Graph API
                              │
                         ~/.graph-mcp/
                           tokens.enc  (encrypted)
                           .key        (auto-generated)
```

- **Auth**: OAuth2 Authorization Code flow with PKCE. Login opens your browser, a local callback server captures the token. No secrets stored in config.
- **Token persistence**: Tokens are encrypted with Fernet and stored in `~/.graph-mcp/tokens.enc`. The encryption key is auto-generated on first use. Logins survive server restarts.
- **Token refresh**: Access tokens are refreshed automatically before they expire. You only need to log in again if the refresh token itself expires.
- **Rate limiting**: Sliding window counter with exponential backoff. Respects `Retry-After` headers on 429 responses.

## Configuration

All configuration is passed via environment variables (set in the MCP config's `env` block):

| Variable | Required | Default | Description |
|---|---|---|---|
| `AZURE_CLIENT_ID` | Yes | — | From your Azure App Registration |
| `AZURE_TENANT_ID` | No | `common` | Your Azure tenant ID, or `common` for multi-tenant |
| `GRAPH_REDIRECT_URI` | No | `http://localhost:3000/auth/callback` | Must match Azure app registration |
| `GRAPH_TOKEN_ENCRYPTION_KEY` | No | auto-generated | Fernet key for token encryption |
| `GRAPH_DEBUG` | No | `false` | Enable verbose logging |

## Troubleshooting

**"Approval required" error during login**
Your Azure app is requesting scopes that aren't registered or need admin consent. Check the API permissions in the Azure portal match the list above.

**403 Forbidden on specific tools**
The endpoint needs a permission that's not in your Azure app registration, or requires admin consent.

**Login works but tools say "not authenticated"**
Restart the MCP server (`claude mcp restart graph`) — it may be running an old version.

## Disclaimer

This project is an independent open-source effort and is **not affiliated with, endorsed by, or sponsored by Microsoft Corporation**. Microsoft, Microsoft Teams, Outlook, Microsoft 365, Microsoft Graph, and Azure are trademarks of the Microsoft group of companies.

This software is provided "as is", without warranty of any kind. Use it at your own risk. The authors accept no liability for any damages, data loss, or security issues arising from the use of this software. You are responsible for complying with your organization's policies and Microsoft's [API Terms of Use](https://learn.microsoft.com/en-us/legal/microsoft-apis/terms-of-use) when using this tool.

This software accesses Microsoft services on your behalf using your own credentials and Azure app registration. Data retrieved from Microsoft Graph (emails, messages, calendar events, etc.) is passed to the LLM that invoked the tool. Be mindful of your organization's data handling policies when using this with cloud-hosted AI models.

## License

MIT — see [LICENSE](LICENSE).
