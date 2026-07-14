# Graph MCP plugin

Graph MCP connects Claude and Codex to Microsoft Graph through a local Node MCP server.
It provides approved access to Microsoft Teams, Outlook mail and calendar, meetings,
files, users, and presence.

## Setup

Register a Microsoft Entra ID public client for **Mobile and desktop applications** with
the redirect URI `http://localhost:3000/auth/callback`, then run the bundled setup skill's
command. Browser login is the default; device-code login is available as a fallback.

Client ID and Tenant ID are identifiers, not secrets. The plugin never requests or stores
a client secret or credentials in conversation. Tokens are encrypted locally under
`~/.graph-mcp`.

Graph data is passed to the invoking model and is subject to BP/organizational policy.
Use least privilege and obtain admin consent where required. Review your organization's
data-handling requirements before enabling Graph access.

See [the setup skill](skills/setup/SKILL.md) for the exact delegated permissions and
installation command.

## License

MIT. See [LICENSE](LICENSE).
