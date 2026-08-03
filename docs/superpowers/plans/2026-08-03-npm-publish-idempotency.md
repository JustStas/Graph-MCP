# npm Publish Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an integrity-matched rerun of an existing npm version succeed without invoking npm's duplicate-version dry-run path.

**Architecture:** Preserve local metadata and byte verification, then classify the exact npm version before constructing a private publication snapshot. Existing matching versions return immediately; only absent versions proceed through dry-run validation, real publication, and bounded readback.

**Tech Stack:** Node.js, npm CLI, TypeScript, Vitest, GitHub Actions.

---

### Task 1: Add the duplicate-version regression contract

**Files:**

- Modify: `tests/release-package.test.ts`

- [ ] **Step 1: Change the existing-version test to reject publication commands**

Update `treats an initial exact registry match as a no-op` so its subprocess double returns
matching registry metadata for `npm view` and throws if either dry-run or actual publication
is attempted. Assert exactly one view call and zero publish calls.

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
npx vitest run tests/release-package.test.ts -t "treats an initial exact registry match as a no-op"
```

Expected: FAIL because the current helper invokes `npm publish --dry-run` before its first
registry lookup.

### Task 2: Classify the registry before publication-only work

**Files:**

- Modify: `scripts/release-package.mjs`
- Modify: `tests/release-package.test.ts`

- [ ] **Step 1: Implement the registry-first branch**

After tarball digest verification, query the exact version and classify it:

```javascript
const remote = await readRegistryMetadata(metadata.name, metadata.version, runFile);
const state = classifyRegistryState(remote, metadata);
if (state === "already-published") {
  return publishedResult(metadata, state);
}
```

Only after this branch create the private snapshot, run dry-run validation, perform the real
publish, and poll for readback. The absent-version path retains its existing error handling.

- [ ] **Step 2: Remove the obsolete changing-existing-version test**

Delete the test that expects a second lookup to observe a changed integrity. npm versions
are immutable, and the authoritative matching lookup now returns immediately by design.

- [ ] **Step 3: Run focused and full verification**

Run:

```bash
npx vitest run tests/release-package.test.ts
npm run verify
```

Expected: all tests and package verification pass.

### Task 3: Integrate and prove the release rerun

**Files:**

- No additional repository files.

- [ ] **Step 1: Commit and create the GitHub pull request**

Commit the design, plan, test, and helper change; push `sn/npm-publish-idempotent`; create a
ready GitHub pull request against `main`; and merge it after checks pass.

- [ ] **Step 2: Rerun the corrected workflow for v0.6.1**

Dispatch `publish.yml` from `main` with `tag=v0.6.1` and `prepare_only=false`.

Expected: package verification passes, the publish job reports an integrity-matched
`already-published` no-op, the workflow succeeds, and npm still reports the original
`0.6.1` integrity.
