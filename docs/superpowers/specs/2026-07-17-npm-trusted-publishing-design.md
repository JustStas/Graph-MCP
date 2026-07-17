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

- The verified remote `v*` tag inventory is exactly `v0.1.0`, `v0.2.0`, `v0.4.0`,
  `v0.4.1`, `v0.4.2`, `v0.4.3`, `v0.5.0`, `v0.5.1`, and annotated tag `v0.6.0`.
  There is no `v0.3.0` or `v0.6.1`.
- Tags `v0.1.0` through `v0.5.1` in that approved inventory contain the historical PyPI
  workflow `.github/workflows/publish.yml` at exact blob
  `d34e5a9a4691ab487629b8f25387fa0456331491`. It uses the `pypi` environment and is
  unrelated to the new npm workflow. `v0.6.0` has no file at that path, and none of the nine
  tags contains `scripts/release-package.mjs`.
- `v0.6.0` is on merged `main`; it remains immutable.
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
- Close the post-merge tag race before auditing history: first restrict all `v*` creation and
  mutation to repository administrators, then audit the exact historical inventory and
  ancestry, and finally make existing and future `v*` tags immutable before creating
  `v0.6.1`.
- Replace long-lived npm automation tokens with GitHub OIDC Trusted Publishing.
- Trigger normal publishing only when a GitHub Release is published.
- Provide a manual dispatch path for controlled recovery, reruns, and bootstrap package
  preparation without publication.
- Permit manual deployment only from `main`, and require the `npm` environment to allow
  exactly branch `main` and tags matching `v*` through separate typed deployment policies.
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

Both paths resolve one release tag and accept only stable `vMAJOR.MINOR.PATCH` syntax with no
leading zeros except zero. Checkout receives the fully qualified `refs/tags/<tag>` ref, never
an unqualified user-controlled ref, and does not persist GitHub credentials. Manual dispatch
is allowed only when `github.ref` is `refs/heads/main`.

After checkout and an explicit fetch of `origin/main`, trusted inline workflow shell code
peels `refs/tags/<tag>^{commit}`, resolves `HEAD`, requires exact equality, and requires the
resolved commit to be an ancestor of `origin/main`. This preflight runs before Node setup,
`npm ci`, or any repository script. The release helper repeats the identity and ancestry
checks later as defense in depth.

### Package job

The package job has `contents: read` and no OIDC permission. It will:

1. Reject any release tag that is not strict stable `vMAJOR.MINOR.PATCH` syntax.
2. Check out only the fully qualified `refs/tags/<tag>` ref with persisted credentials
   disabled.
3. Fetch `origin/main` and run the trusted inline tag/HEAD/ancestry preflight before setup or
   repository code.
4. Set up Node 24 on a GitHub-hosted Ubuntu runner and require an exact stable npm version at
   least `11.5.1`.
5. Disable automatic package-manager caching.
6. Run `npm ci` and `npm run verify`.
7. Run the hardened release helper, which repeats package, tag, commit, and ancestry checks
   before creating the publish tarball with `npm pack --json`.
8. Use trusted inline workflow code to require the exact package name, stable version,
   matching tag, exact scoped-package tarball basename, and existing tarball before writing
   the strict artifact-name output. The package job does not provide a release-tag output to
   the privileged job.
9. Upload only `release/*.tgz` and `release/package-metadata.json` as a one-day workflow
   artifact. The copied `release-package.mjs` is deliberately excluded.

External actions will be limited to official GitHub actions. Every action reference will be
pinned to a full commit SHA with a version comment. Current audited majors will be resolved
at implementation time, including checkout, Node setup, and artifact transfer actions.

### Publish job

The publish job depends on the package job. Release events preserve normal publication;
manual publication is allowed only from `refs/heads/main` with `prepare_only` false. It runs
in the GitHub environment `npm` and has only the permissions needed to read workflow
artifacts, read repository contents, and request an OIDC token. It will:

1. Check out the repository at `github.workflow_sha` under `trusted-source` with persisted
   credentials disabled. This supplies the trusted publish helper from the same commit as the
   executing workflow definition without installing dependencies or running package code.
2. Set up Node 24 and require an exact stable npm version at least `11.5.1`.
3. Download the named data-only tarball and metadata artifact produced by the package job.
4. Derive `EXPECTED_RELEASE_TAG` directly from `github.event.release.tag_name || inputs.tag`.
   Never accept a package-job output or downloaded metadata as the expected release identity.
5. Use trusted inline workflow code to revalidate the exact package name, strict version,
   event/input-derived expected tag, tag-derived version, exact tarball basename, and file
   existence.
6. Execute `trusted-source/scripts/release-package.mjs publish <metadata-json>
<expected-tag>`, passing the event/input-derived tag through a quoted environment variable.
   Never execute content from the downloaded artifact.
7. The helper validates the explicit expected tag and metadata tag, recomputes both tarball
   digests, and creates a private snapshot. It then runs `npm publish <snapshot> --dry-run
--json` with the same access, tag, script, and registry controls as real publication.
8. Require npm's dry-run `id`, `name`, `version`, `filename`, `shasum`, and `integrity` to
   match the trusted sidecar metadata before any registry lookup or real publish.
9. Query npm for the exact package version and publish only when it is absent, using the exact
   same private snapshot validated by the dry run.
10. If the version exists, compare npm's `dist.integrity` with the prepared tarball integrity.
    Matching bytes produce a successful no-op; different bytes fail hard.
11. Read the published version and integrity back from npm before succeeding.

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
- Create the GitHub environment named `npm` before configuring npm trust. Enable custom
  deployment policies and create separate typed policies for branch `main` and tag `v*`.
  GitHub matches these policy types against `GITHUB_REF`; both policies are mandatory so only
  manual runs from `main` and release runs for `v*` tags can reach OIDC publication.
- Include the `npm` environment in npm's trust relationship.
- Pin every external action to a full commit SHA.
- Pass checkout only fully qualified tag refs or `github.workflow_sha`, and set
  `persist-credentials: false` on both checkout uses.
- Run the trusted inline tag/HEAD/`origin/main` preflight before setup, dependency
  installation, or repository code.
- Disable dependency caching in release jobs to reduce cache-poisoning risk.
- Keep the package lock committed and install with `npm ci`.
- Require an exact stable npm version at least `11.5.1` in both jobs.
- Transfer only the prepared tarball and JSON metadata into the privileged job. Source the
  publish helper from `github.workflow_sha`, not from the downloaded artifact.
- Bind privileged publication directly to the release-event or manual input tag. The package
  artifact and package job cannot redefine the expected release tag.
- Require npm's own JSON dry-run manifest for the exact private snapshot to match trusted
  metadata before registry access, and use that same snapshot for real publication.
- Store no npm automation token in GitHub.
- After the trust relationship is saved and its identity fields are verified, set npm
  publishing access to "Require two-factor authentication and disallow tokens" and revoke any
  unused publish-capable tokens. The first actual OIDC exchange is verified by the next new
  version published through the workflow.
- Preserve the exact `repository.url` association and automatic provenance on future
  OIDC-published versions.

Two active repository tag rulesets are required before `v0.6.1` is created. Immediately after
merged `main` is verified, an administrator-authority ruleset applies `creation`, `update`,
`deletion`, and `non_fast_forward` to `refs/tags/v*`; its sole `always` bypass is the repository
administrator `RepositoryRole` actor with ID `5`. This closes non-administrator creation and
mutation races while the existing tags are audited. The audit must use the exact sorted remote
inventory without annotated-tag peel lines, peel every approved tag to a commit, require every
commit to be an ancestor of current `origin/main`, require the exact historical PyPI workflow
blob `d34e5a9a4691ab487629b8f25387fa0456331491` on `v0.1.0` through `v0.5.1`, require that
workflow path to be absent on `v0.6.0`, and require `scripts/release-package.mjs` to be absent
on every approved tag. The allowlisted blob is different, unrelated PyPI workflow content and
declares environment `pypi`, so it cannot satisfy the npm trust relationship that requires
environment `npm`. Any missing, altered, or unexpected workflow/helper content stops rollout
without deleting or moving a tag.

Only after that audit passes, a separate no-bypass ruleset applies `update`, `deletion`, and
`non_fast_forward` to make existing and future matching tags immutable. It deliberately has no
`creation` rule, so the repository administrator can create `v0.6.1` through the authority
ruleset while the no-bypass ruleset prevents later movement or deletion. Both rulesets are
verified exactly after creation, after `v0.6.1` is pushed, and again before environment or npm
trust configuration. The `npm` environment and its separate typed branch `main` and tag `v*`
deployment policies are also required. Environment tag matching alone is insufficient because a
manual workflow can otherwise target an attacker-created `v*` tag. A required environment
reviewer remains optional operational hardening and is not prescribed here.

## Bootstrap and Release Sequence

The first scoped release cannot use OIDC from start to finish because npm will not save a
trusted publisher for a package that does not yet exist.

1. Merge the implementation pull request to `main`.
2. Re-run the complete verification pipeline from merged `main`.
3. Create or find exactly one active `refs/tags/v*` administrator-authority ruleset through the
   repository rulesets REST API. Require exactly `creation`, `update`, `deletion`, and
   `non_fast_forward`, with only `RepositoryRole` actor ID `5` as an `always` bypass.
4. Audit the exact existing remote inventory with `git ls-remote --refs --tags`, require the nine
   approved tags and no others, fetch and peel each tag, require every peeled commit to be an
   ancestor of current `origin/main`, require the exact allowlisted historical PyPI workflow blob
   on `v0.1.0` through `v0.5.1`, require that workflow path absent on `v0.6.0`, and require the
   new release helper absent everywhere. Stop for explicit investigation if any check differs;
   do not delete or move tags automatically.
5. Create or find exactly one active no-bypass `refs/tags/v*` immutability ruleset with exactly
   `update`, `deletion`, and `non_fast_forward`, then verify both rulesets exactly through the
   repository rulesets REST API.
6. Create and push annotated tag `v0.6.1` on verified merged `main`. Verify it peels to that exact
   commit and both rulesets remain active with their exact conditions, rules, and bypasses.
7. Manually dispatch `publish.yml` for `v0.6.1` with `prepare_only: true`.
8. Verify the package job succeeds and download its exact tarball and metadata artifact.
9. Publish that prepared tarball once with the maintainer's interactive npm 2FA.
10. Verify npm returns version `0.6.1` and the artifact's expected integrity.
11. Verify both existing tag rulesets exactly again before creating any environment or npm trust.
12. Create the GitHub environment `npm`, enable custom deployment policies, and create two
    separate typed policies: branch name `main` and tag name `v*`.
13. Verify the environment reports custom policies enabled and exactly those branch and tag
    policies before configuring npm trust.
14. With npm 11.15.0 or later, configure trust:

```bash
npm trust github @juststas/graph-mcp \
  --file publish.yml \
  --repo JustStas/Graph-MCP \
  --env npm \
  --allow-publish
```

15. Verify the saved trusted-publisher fields.
16. Change npm publishing access to require 2FA and disallow traditional tokens.
17. Create the GitHub Release for `v0.6.1`.
18. The release workflow rebuilds and verifies the tarball. Because `0.6.1` already exists,
    it succeeds only if the registry integrity matches.
19. Verify registry metadata, global installation, `graph-mcp --version`, and a clean MCP
    startup from the installed package. Record that `0.6.1` is the manual bootstrap exception;
    both the first real OIDC publish test and provenance check are deferred to `0.6.2`.

The maintainer is expected to interact only for npm's 2FA/passkey challenges and any npm
website setting that lacks a safe CLI equivalent.

## Error Handling and Recovery

- Malformed or unqualified tags, tag/HEAD mismatch, or a tag outside `main` fails in trusted
  inline workflow code before dependencies or repository code execute.
- Any pre-immutability tag inventory, ancestry, historical workflow-blob, or helper-presence
  mismatch stops rollout while only the trusted administrator can mutate matching tags. An
  unexpected historical npm workflow/helper is a hard stop. The procedure contains no
  destructive tag command and requires explicit investigation and user direction.
- Test, build, plugin-version, or package-content failures stop before the OIDC job.
- Missing or malformed artifact metadata stops publication.
- Executable files in the package staging directory are not uploaded to the publish job.
- An event/input tag mismatch fails before any npm command. Malformed or mismatched npm
  dry-run JSON fails before registry lookup or non-dry-run publication.
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
- Promote exact `js-yaml@4.3.0` to a direct development dependency and parse the workflow
  semantically rather than searching comments or raw YAML text.
- Add a release-workflow contract test that validates:
  - exact release/manual trigger and input structures;
  - package and publish truth tables, including main-only manual execution;
  - effective permissions, environment, runners, timeouts, outputs, and step order;
  - exact full-SHA action multiset with checkout and setup-node each used twice;
  - fully qualified tag checkout, `github.workflow_sha` helper checkout, and disabled
    persisted credentials;
  - trusted inline tag validation and commit/ancestry preflight before repository code;
  - the exact data-only artifact allowlist and absence of downloaded executable code;
  - trusted-source helper execution and publish-job-only OIDC;
  - event/input-derived expected-tag binding with no package release-tag output;
  - executable release/manual truth-table rows and npm gate boundaries, including rejection
    of `11.5.0`, malformed versions, and prereleases;
  - absence of `NODE_AUTH_TOKEN`, `NPM_TOKEN`, and `secrets.*` in semantic workflow values.
- Extend release-helper tests to require an explicit expected tag, reject mismatches before npm,
  validate exact npm dry-run manifest identity and digests, assert all dry-run safety flags,
  prohibit real publish on mismatch, and preserve absent, already-published, and race recovery
  behavior through the same private snapshot.
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
  mandatory administrator-authority/historical-audit/immutability tag sequence, mandatory typed
  branch `main` and tag `v*` deployment policies, the `0.6.1` provenance exception, automatic
  provenance for future versions, integrity-safe reruns, and recovery process.
- Add a `0.6.1` changelog entry covering the scoped package and secure release automation.

## Authoritative References

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
- [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust)
- [npm Staged Publishing](https://docs.npmjs.com/staged-publishing)
- [GitHub release workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub repository rulesets REST API](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset)
- [`setup-node` Trusted Publisher guidance](https://github.com/actions/setup-node/blob/v7.0.0/docs/advanced-usage.md#publishing-to-npm-with-trusted-publisher-oidc)
