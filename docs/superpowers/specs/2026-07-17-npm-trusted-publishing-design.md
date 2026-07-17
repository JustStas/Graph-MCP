# Graph MCP npm Trusted Publishing Design

**Date:** 2026-07-17
**Status:** Approved for specification
**Target release:** 0.6.1

## Summary

Publish Graph MCP as the public scoped npm package `@juststas/graph-mcp` and add a
GitHub Actions release workflow that uses npm Trusted Publishing through OpenID Connect
(OIDC). The executable and Claude/Codex plugin names remain `graph-mcp`.

The first scoped release must be bootstrapped manually because npm requires a package to
exist before a trusted publisher can be configured. After `0.6.1` is published with the
maintainer's two-factor authentication, npm will trust one GitHub-hosted workflow bound to
this repository, workflow filename, and deployment environment. The bootstrap `0.6.1`
version will not have provenance because npm cannot add it retroactively. Versions published
through OIDC beginning with `0.6.2` will receive automatic npm provenance.

## Current State and Constraints

- `v0.6.0` is an annotated public tag on merged `main`; it remains immutable.
- No GitHub Release exists for `v0.6.0`.
- `graph-mcp@0.6.0` was never accepted by npm. npm rejected the unscoped package name
  because it is too similar to the existing `graphmcp` package.
- npm recommended `@juststas/graph-mcp`; that scoped package is currently unused.
- The current executable, MCP registration name, plugin names, and local configuration path
  are all `graph-mcp` and do not need to change.
- npm Trusted Publishing requires a GitHub-hosted runner, npm 11.5.1 or later, and Node
  22.14.0 or later. The workflow will use Node 24.
- `npm trust` additionally requires npm 11.15.0 or later, package write access, account-level
  2FA, and an already-existing npm package.
- The repository and package are public, so future versions actually published through
  Trusted Publishing will generate provenance automatically.

## Goals

- Publish the first public scoped package as `@juststas/graph-mcp@0.6.1`.
- Keep the installed CLI command and plugin identifiers as `graph-mcp`.
- Preserve the public `v0.6.0` tag and create a new `v0.6.1` release tag.
- Replace long-lived npm automation tokens with GitHub OIDC Trusted Publishing.
- Trigger normal publishing only when a GitHub Release is published.
- Provide a manual dispatch path for controlled recovery, reruns, and bootstrap package
  preparation without publication.
- Keep OIDC permission out of dependency installation, tests, and package construction.
- Make reruns safe without accepting a different tarball for an existing package version.
- Generate npm provenance automatically for OIDC-published versions beginning with `0.6.2`.
- Update installation and release documentation for the scoped package and automated flow.
- Verify the installed npm package still exposes `graph-mcp` and reports version `0.6.1`.

## Non-goals

- Moving or deleting the existing `v0.6.0` tag.
- Renaming the CLI command, MCP server name, plugin directories, marketplace entries, tool
  names, or `~/.graph-mcp` configuration directory.
- Publishing to GitHub Packages, PyPI, or any marketplace during this release.
- Storing an npm token in GitHub Actions.
- Using self-hosted runners for npm publication.
- Adopting npm staged publishing for the normal release path. It remains a future option if
  every release should require a second npm-side approval.
- Refactoring Microsoft Graph runtime behavior.

## Approaches Considered

### 1. GitHub Release with direct OIDC publishing

Run the workflow for `release.published`, verify and package without OIDC permission, then
publish the prepared tarball from a separate OIDC-enabled job.

**Advantages**

- Matches GitHub's documented release-to-package model.
- Uses short-lived credentials and automatic provenance.
- A GitHub Release is an explicit human-controlled deployment event.
- No npm secret needs storage or rotation.
- Separating package preparation from publication minimizes privileged code execution.

**Disadvantages**

- The first package version still requires an interactive bootstrap publish.
- Repository release and workflow protections must remain well maintained.

### 2. GitHub Release with npm staged publishing

Use OIDC to run `npm stage publish`, then require a maintainer to inspect and approve the
staged package with 2FA.

**Advantages**

- npm documents this as the maximum-security publishing posture.
- The package can be reviewed after CI construction but before public release.

**Disadvantages**

- Every version needs a second manual approval after the GitHub Release.
- A brand-new package still cannot be bootstrapped through staged publishing.
- The extra approval duplicates the deliberate GitHub Release action for this repository.

### 3. Direct publication on tag push

Publish whenever a matching `v*` tag is pushed.

**Advantages**

- Minimal release ceremony.

**Disadvantages**

- A premature or accidental tag starts deployment immediately.
- It offers a weaker human release boundary than a published GitHub Release.
- Bootstrap ordering is harder because the first scoped package and trust relationship do
  not yet exist.

### Decision

Use approach 1: direct OIDC publication from a published GitHub Release, with a manual
dispatch recovery path in the same workflow file.

## Package Identity and Metadata

`package.json` will use:

- `name`: `@juststas/graph-mcp`
- `version`: `0.6.1`
- `bin.graph-mcp`: `dist/cli.js`
- `publishConfig.access`: `public`
- a normalized repository object pointing to `JustStas/Graph-MCP`

The leading `./` will be removed from the bin path and the repository string will be replaced
with npm's canonical object form, eliminating the metadata corrections reported by
`npm publish`.

The root package, package lock, Claude manifest, and Codex manifest must all report `0.6.1`.
The compiled CLI must continue reporting `0.6.1`, and committed plugin artifacts must be
rebuilt through the existing deterministic build path.

The README will install the scoped package but invoke the unchanged command:

```bash
npm install --global @juststas/graph-mcp
graph-mcp setup
```

## Workflow Architecture

The trusted workflow is `.github/workflows/publish.yml`. The npm trusted-publisher
configuration records only `publish.yml`, repository `JustStas/Graph-MCP`, environment
`npm`, and permission to run `npm publish`.

### Triggers

- `release` with activity type `published` is the normal path.
- `workflow_dispatch` accepts one required release tag and a `prepare_only` boolean. Prepare
  mode runs verification and creates the release artifact without starting the publish job;
  normal manual recovery runs both jobs.
- The workflow will not expose `workflow_call`; npm documents identity pitfalls when a
  reusable workflow performs the publish on behalf of another workflow.

Both paths resolve one release tag, check out that exact tag, and require the tag to equal
`v${package.version}`. The tagged commit must be an ancestor of `origin/main`.

### Package job

The package job has `contents: read` and no OIDC permission. It will:

1. Check out the resolved release tag.
2. Set up Node 24 on a GitHub-hosted Ubuntu runner.
3. Disable automatic package-manager caching.
4. Assert the package name is `@juststas/graph-mcp`.
5. Assert the tag is exactly `v${package.version}` and the commit belongs to `main`.
6. Run `npm ci` and `npm run verify`.
7. Create the publish tarball with `npm pack --json`.
8. Record the tarball filename, package name, version, shasum, and integrity.
9. Upload only the tarball and its machine-readable metadata as a short-lived workflow
   artifact.

External actions will be limited to official GitHub actions. Every action reference will be
pinned to a full commit SHA with a version comment. Current audited majors will be resolved
at implementation time, including checkout, Node setup, and artifact transfer actions.

### Publish job

The publish job depends on the package job and is skipped only for a manual `prepare_only`
dispatch. It runs in the GitHub environment `npm` and has only the permissions needed to read
workflow artifacts and request an OIDC token. It will:

1. Download the tarball and metadata produced by the package job.
2. Revalidate the expected package name and tag-derived version.
3. Query npm for the exact package version.
4. If the version does not exist, publish the tarball publicly with `npm publish`.
5. If the version exists, compare npm's `dist.integrity` with the prepared tarball integrity.
   Matching bytes produce a successful no-op; different bytes fail hard.
6. Read the published version and integrity back from npm before succeeding.

The job will not define `NODE_AUTH_TOKEN` or any npm publish secret. npm CLI will detect the
GitHub OIDC environment and exchange the workflow identity for a short-lived publish token.
Trusted Publishing generates provenance automatically when this job performs a new publish,
so the command does not need a `--provenance` flag. An integrity-matched no-op does not add
provenance to an existing version.

One non-canceling concurrency group will serialize npm publication attempts. A timeout will
bound each job so a stalled registry or runner cannot hold the deployment indefinitely.

## Security Controls

- Use only GitHub-hosted runners; npm does not support self-hosted trusted publishers.
- Give `id-token: write` only to the final publish job.
- Set all other workflow permissions explicitly to read-only or none.
- Use a GitHub environment named `npm` and include that environment in npm's trust
  relationship.
- Pin every external action to a full commit SHA.
- Disable dependency caching in release jobs to reduce cache-poisoning risk.
- Keep the package lock committed and install with `npm ci`.
- Publish a previously prepared tarball rather than rebuilding in the privileged job.
- Store no npm automation token in GitHub.
- After the trust relationship is saved and its identity fields are verified, set npm
  publishing access to "Require two-factor authentication and disallow tokens" and revoke any
  unused publish-capable tokens. The first actual OIDC exchange is verified by the next new
  version published through the workflow.
- Preserve the exact `repository.url` association and automatic provenance on future
  OIDC-published versions.

Repository tag protection or a release ruleset is recommended as a separate repository
administration step. It is not required to complete the package publication work and will not
be changed implicitly.

## Bootstrap and Release Sequence

The first scoped release cannot use OIDC from start to finish because npm will not save a
trusted publisher for a package that does not yet exist.

1. Merge the implementation pull request to `main`.
2. Re-run the complete verification pipeline from merged `main`.
3. Create and push annotated tag `v0.6.1` on that verified commit.
4. Manually dispatch `publish.yml` for `v0.6.1` with `prepare_only: true`.
5. Verify the package job succeeds and download its exact tarball and metadata artifact.
6. Publish that prepared tarball once with the maintainer's interactive npm 2FA.
7. Verify npm returns version `0.6.1` and the artifact's expected integrity.
8. Create the GitHub environment `npm` if it does not already exist.
9. With npm 11.15.0 or later, configure trust:

   ```bash
   npm trust github @juststas/graph-mcp \
     --file publish.yml \
     --repo JustStas/Graph-MCP \
     --env npm \
     --allow-publish
   ```

10. Verify the saved trusted-publisher fields.
11. Change npm publishing access to require 2FA and disallow traditional tokens.
12. Create the GitHub Release for `v0.6.1`.
13. The release workflow rebuilds and verifies the tarball. Because `0.6.1` already exists,
    it succeeds only if the registry integrity matches.
14. Verify registry metadata, global installation, `graph-mcp --version`, and a clean MCP
    startup from the installed package. Record that `0.6.1` is the manual bootstrap exception;
    both the first real OIDC publish test and provenance check are deferred to `0.6.2`.

The maintainer is expected to interact only for npm's 2FA/passkey challenges and any npm
website setting that lacks a safe CLI equivalent.

## Error Handling and Recovery

- Wrong package name, tag/version mismatch, or a tag outside `main` fails before packaging.
- Test, build, plugin-version, or package-content failures stop before the OIDC job.
- Missing or malformed artifact metadata stops publication.
- An existing version with different integrity is treated as an immutable-version conflict;
  the workflow will not overwrite or silently accept it.
- OIDC errors must surface the configured repository, workflow filename, and environment
  values for comparison, without printing credentials.
- A partial registry failure is resolved by rerunning the same tag. The integrity guard makes
  this safe if npm accepted the first request before the runner lost its response.
- A bad published version is never overwritten or unpublished automatically. Recovery uses a
  new patch release.
- Trusted publishing can be disabled by revoking the npm trust relationship or disabling the
  workflow; no stored credential needs rotation.

## Testing and Verification

Implementation will follow test-driven development.

### Automated contract tests

- Update project metadata tests to require the scoped package name, version `0.6.1`, unchanged
  `graph-mcp` executable, normalized repository metadata, and public publish configuration.
- Update package tests to require the scoped name while preserving the five-file allowlisted
  npm payload and executable behavior.
- Add a release-workflow contract test that validates:
  - release and manual triggers, including non-publishing bootstrap preparation;
  - exact GitHub environment name;
  - least-privilege permissions and publish-job-only OIDC;
  - GitHub-hosted runner and Node 24;
  - disabled package-manager caching;
  - full-SHA action pins;
  - absence of `NODE_AUTH_TOKEN` and npm secrets;
  - package/tag/main validation;
  - separate package and publish jobs;
  - integrity-aware idempotency;
  - direct tarball publication.
- Preserve plugin version synchronization, package-content, CLI, stdio, and installation
  smoke tests.

### Required verification before merge

```bash
npm ci
npm run verify
npm pack --json --dry-run
git status --short
```

The package dry run must contain only the existing allowlisted files and identify
`@juststas/graph-mcp@0.6.1`.

### Required verification after release

```bash
npm view @juststas/graph-mcp@0.6.1 version dist.integrity repository --json
npm install --global @juststas/graph-mcp@0.6.1
graph-mcp --version
```

The installed executable must report `0.6.1`. A clean temporary MCP host launch must discover
all 44 tools from the installed package. The trusted-publisher configuration must match
`JustStas/Graph-MCP`, `publish.yml`, and environment `npm`. Provenance is not expected on the
manual bootstrap version. The no-op `0.6.1` release run does not exercise npm's OIDC exchange;
both OIDC authentication and provenance must be checked on `0.6.2`.

## Documentation Changes

- Change npm installation examples to `npm install --global @juststas/graph-mcp`.
- Explicitly state that the command remains `graph-mcp`.
- Document `0.6.1` as the first scoped npm release and explain why `0.6.0` was not published.
- Replace manual normal-release instructions with the GitHub Release and Trusted Publishing
  flow.
- Keep a clearly marked one-time bootstrap procedure for a brand-new npm package.
- Document the `npm` GitHub environment, trusted-publisher identity fields, 2FA/token setting,
  the `0.6.1` provenance exception, automatic provenance for future versions,
  integrity-safe reruns, and recovery process.
- Add a `0.6.1` changelog entry covering the scoped package and secure release automation.

## Authoritative References

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
- [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust)
- [npm Staged Publishing](https://docs.npmjs.com/staged-publishing)
- [GitHub release workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions)
- [`setup-node` Trusted Publisher guidance](https://github.com/actions/setup-node/blob/v7.0.0/docs/advanced-usage.md#publishing-to-npm-with-trusted-publisher-oidc)
