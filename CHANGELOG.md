# Changelog

All notable changes to Graph MCP are documented in this file.

## 0.6.0 - 2026-07-16

### Changed

- Replaced the Python runtime with a Node.js 22+ TypeScript implementation while preserving
  the 44-tool MCP contract, Graph paths, defaults, response envelopes, and delegated scopes.
- Kept the `graph-mcp` executable name and added deterministic npm build, test, package, and
  version-validation workflows.
- Added browser PKCE and device-code authentication with serialized token refresh, hardened
  logout, bounded Graph requests, throttling, and retry behavior.
- Moved Node token storage to AES-256-GCM encrypted `~/.graph-mcp/tokens-v2.enc` with
  `.key-v2`. Existing Python `tokens.enc` and `.key` files are never read or modified; users
  authenticate once after upgrading.

### Added

- Self-contained Claude Code and Codex plugins with host-specific manifests, local marketplace
  metadata, a bundled setup skill, and a committed runtime bundle.
- Isolated end-to-end marketplace installation tests that launch each installed plugin and
  verify the exact 44-tool inventory and full MCP metadata.
- npm CLI, stdio protocol, package-content, plugin-artifact, authentication, storage, retry,
  and tool-parity verification.

### Removed

- Python package, runtime source, and Python-only tests after equivalent Node contract and
  behavior coverage passed.
