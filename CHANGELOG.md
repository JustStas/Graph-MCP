# Changelog

All notable changes to Graph MCP are documented in this file.

## 0.7.0 - 2026-08-03

### Added

The tool inventory grows from 44 to 125 tools. Graph MCP could previously read a mailbox but
not act on one, and whole domains a person uses daily were absent. Everything below is
Microsoft Graph v1.0 with delegated permissions.

- Mail lifecycle: move and archive, delete, mark read or unread, flag, categorize, list and
  create folders, and list, create, or delete inbox rules. The batch tools accept up to 50
  message IDs per call and report per-message outcomes, so a partial failure still says what
  succeeded.
- Mail composition: forward, create a draft, attach a file, send a draft, and reply or forward
  as an unsent draft. Send and draft creation gained bcc, importance, reply-to, and control
  over saving to Sent Items.
- Shared and delegated mailboxes: every mail tool takes a `mailbox` argument that targets
  `/users/{id}` instead of `/me`. Sending as a shared mailbox also needs Send As rights in
  Exchange, not just the delegated permission.
- Mail paging and sync: a `skip` argument on `graph_list_mail`, and `graph_get_mail_delta` for
  incremental folder sync with a resumable delta token.
- Mail tips, so an assistant can check whether someone is out of office before writing to them,
  and master categories for reading and creating Outlook categories.
- Mailbox settings: read settings, set or clear automatic replies, set the time zone and
  working hours, and read a colleague's time zone and working hours.
- Calendar: cancel a meeting with notification, list the occurrences of a series, suggested
  meeting times, bookable rooms from the tenant place list, recurrence patterns on event
  creation, and richer event fields (all-day, show-as, sensitivity, reminders, optional
  attendees, categories, new-time proposals, response requested). Every calendar tool takes a
  `user` argument for shared and delegated calendars.
- Chats: get a single chat, rename a chat, add or remove members, mark read or unread, edit or
  soft-delete your own messages, and set or remove emoji reactions on chat and channel
  messages. Chat sends gained importance and subject.
- Teams and channels: list team members, get a team or its primary channel, create channels,
  edit or soft-delete channel messages, and reach a channel's SharePoint files folder.
- Meetings: create an online meeting and get its join link, get a meeting by ID, and read
  attendance reports showing who actually joined and for how long.
- Presence: look up presence for up to 650 users in one call, set a status message with an
  optional expiry, and clear presence.
- Files: copy items, list and revoke permissions, invite people by email, list and restore
  versions, list recent files, list drives, resolve a sharing link, search SharePoint sites,
  and list a site's document libraries.
- Excel: list worksheets and read or write worksheet ranges, so spreadsheets can be inspected
  and updated in place.
- People and contacts: relevance-ranked people search that also finds external contacts, and
  list, create, update, or delete Outlook contacts plus contact folders.
- Tasks: Microsoft To Do lists and tasks with create, update, complete, and delete, plus the
  Planner tasks assigned to the user.
- Org directory: look up a user's manager or direct reports.
- Search: one relevance-ranked query across mail, calendar, files, and Teams.
- Delegated scopes grew from 23 to 41 to cover the above. Several need administrator consent:
  TeamMember.Read.All, OnlineMeetingArtifact.Read.All, User.Read.All, Sites.Read.All, and
  Place.Read.All.

### Fixed

- The release helper now accepts npm 11's `npm publish --dry-run --json` output, which nests the
  manifest under the package name instead of printing it flat like npm 10. The publish job
  requires an OIDC-capable npm, so every release attempt failed manifest validation with
  "npm publish dry-run name must be a non-empty string" before reaching the registry.

### Changed

- `MAIL_LIST_FIELDS` now selects `webLink`, `conversationId`, and `parentFolderId` so listed
  messages can be linked and grouped into threads without a request per message.

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
