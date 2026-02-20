from __future__ import annotations

import json
import logging
import shutil
import sys

from fastmcp import FastMCP

from graph_mcp.config import settings
from graph_mcp.token_store import token_store
from graph_mcp.tools import register_all_tools

mcp = FastMCP(
    "Graph MCP",
    instructions=(
        "Microsoft Teams, Outlook Calendar, and Mail integration "
        "via Microsoft Graph API"
    ),
)

register_all_tools(mcp)


def setup() -> None:
    """Interactive first-time setup."""
    print("Graph MCP — Setup\n")

    # 1. Get Azure Client ID
    print("  You need an Azure App Registration (public client, mobile/desktop platform).")
    print("  See: https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app\n")
    client_id = input("  Azure Client ID: ").strip()

    if not client_id:
        print("\n  Error: Azure Client ID is required.")
        sys.exit(1)

    # 2. Tenant ID
    tenant_id = input("  Tenant ID (leave blank for \"common\"): ").strip() or "common"

    # 3. Build the claude mcp add command
    binary = shutil.which("graph-mcp") or "graph-mcp"
    env_flags = f'-e AZURE_CLIENT_ID={client_id}'
    if tenant_id != "common":
        env_flags += f' -e AZURE_TENANT_ID={tenant_id}'

    print(f"\n  Run this to register with Claude Code:\n")
    print(f"    claude mcp add graph {env_flags} -- {binary}\n")

    # 4. Also show the manual JSON config
    env_block: dict[str, str] = {"AZURE_CLIENT_ID": client_id}
    if tenant_id != "common":
        env_block["AZURE_TENANT_ID"] = tenant_id
    mcp_config = {
        "type": "stdio",
        "command": binary,
        "env": env_block,
    }
    print("  Or add manually to ~/.claude.json under \"mcpServers\":\n")
    config_json = json.dumps({"graph": mcp_config}, indent=2)
    for line in config_json.splitlines():
        print(f"    {line}")

    print("\n  Then start a conversation and ask Claude to log in.\n")


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "setup":
        setup()
        return

    if settings.graph_debug:
        logging.basicConfig(level=logging.DEBUG)
    else:
        logging.basicConfig(level=logging.WARNING)

    if not settings.azure_client_id:
        print(
            "Error: AZURE_CLIENT_ID not configured.\n"
            "Run 'graph-mcp setup' for first-time setup.",
            file=sys.stderr,
        )
        sys.exit(1)

    token_store.configure(
        encryption_key=settings.graph_token_encryption_key,
    )

    mcp.run(transport="stdio")
