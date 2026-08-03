# Changelog

All notable changes to Graph MCP are documented in this file.

## 0.7.0 - 2026-08-03

### Added

- Mail lifecycle tools so mailboxes can be tidied and not only read: `graph_move_mail`
  (archive or move to any folder), `graph_delete_mail`, `graph_mark_mail_read`,
  `graph_flag_mail`, `graph_list_mail_folders`, and `graph_create_mail_folder`. The batch
  tools accept up to 50 message IDs per call and report per-message outcomes, so a partial
  failure still says what succeeded.
- Mail composition tools: `graph_forward_mail`, `graph_create_mail_draft`,
  `graph_add_mail_attachment` (3MB limit), and `graph_send_mail_draft`. Together these give
  outbound mail with attachments, which previously had no path at all.
- Mailbox settings tools `graph_get_mailbox_settings` and `graph_set_automatic_replies` for
  reading time zone and working hours and for setting or clearing out-of-office replies.
- Calendar tools `graph_respond_to_event` (accept, decline, or tentatively accept an invite,
  with an optional comment) and `graph_get_schedule` (free/busy for people and rooms).
  `graph_update_event` now also accepts `attendees`.
- OneDrive tools `graph_create_folder`, `graph_delete_file`, `graph_move_file` (move and
  rename), and `graph_list_shared_files`.
- A `skip` argument on `graph_list_mail`. Graph returns at most 50 messages per call and the
  server exposed no way to page, so anything past the newest 50 messages in a folder was
  unreachable.
- Delegated scopes `Mail.ReadWrite` and `MailboxSettings.ReadWrite`, which the new write and
  settings tools require.

### Changed

- The tool inventory is now 62 tools, up from 44.
- `MAIL_LIST_FIELDS` now selects `webLink`, `conversationId`, and `parentFolderId` so listed
  messages can be linked and grouped into threads without a second request per message.

## 0.6.1 - 2026-07-17

### Changed

- Changed the npm package identity to @juststas/graph-mcp while preserving the graph-mcp
  executable and Claude/Codex plugin names. npm rejected the unscoped graph-mcp@0.6.0 name as
  too similar to the existing graphmcp package, so 0.6.1 is the first scoped npm release.
- Normalized npm bin and repository metadata and synchronized all runtime and plugin versions.
- Updated the MCP SDK to 1.30.0 and refreshed vulnerable transitive dependencies discovered
  during release verification.
- Updated installation and release documentation for the scoped package.

### Added

- A GitHub Release workflow with separate package and OIDC publish jobs, immutable action pins,
  disabled release caching, integrity-safe reruns, and a non-publishing bootstrap mode.
- A documented npm Trusted Publishing bootstrap and verification procedure for tokenless
  releases after the manual 0.6.1 bootstrap. Version 0.6.2 is the first planned OIDC publish
  with npm provenance.

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
