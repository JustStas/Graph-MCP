# Graph MCP plugin

Graph MCP connects Claude and Codex to Microsoft Graph through a local Node MCP server.
It provides approved access to Microsoft Teams, Outlook mail and calendar, meetings,
files, users, and presence through exactly 44 tools. Node.js 22 or newer is required.

## Install

From a checkout containing the Graph MCP marketplace metadata, install with the command for
your host:

```bash
claude plugin marketplace add /absolute/path/to/Graph-MCP --scope user
claude plugin install graph-mcp@graph-mcp --scope user
```

```bash
codex plugin marketplace add /absolute/path/to/Graph-MCP --json
codex plugin add graph-mcp@personal --json
```

## Setup

Register a Microsoft Entra ID public client for **Mobile and desktop applications** with
the redirect URI `http://localhost:3000/auth/callback`, then follow the bundled setup skill.
The setup command saves the Client ID and Tenant ID but does not log in. Call
`graph_auth_login` afterward. Browser login is the default; use `method: "device_code"` when
a browser or loopback callback is unavailable.

Client ID and Tenant ID are identifiers, not secrets. The plugin never requests or stores
a client secret or credentials in conversation. Tokens are encrypted locally under
`~/.graph-mcp` as `tokens-v2.enc` and `.key-v2`. Users migrating from the Python runtime log
in once; legacy `tokens.enc` and `.key` files remain untouched.

Graph data is passed to the invoking model and is subject to BP/organizational policy.
Use least privilege and obtain admin consent where required. Review your organization's
data-handling requirements before enabling Graph access.

See [the setup skill](skills/setup/SKILL.md) for the exact delegated permissions,
host-specific setup command, configuration alternatives, and authentication guidance.

## License

MIT. See [LICENSE](LICENSE).
