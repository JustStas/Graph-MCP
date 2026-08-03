# npm Publish Idempotency Design

**Date:** 2026-08-03
**Status:** Approved for implementation

## Summary

Make release reruns for an already-published npm version succeed without invoking
`npm publish --dry-run`. npm rejects a dry run when the requested version already exists,
so the release helper must classify registry state before entering the publication-only path.

## Design

The helper continues to validate the expected release tag, metadata, tarball location, file
type, canonical path, SHA-512 integrity, and SHA-1 shasum before accessing the registry. It
then queries npm for the exact package version.

- If the version exists with matching integrity, return `already-published` immediately.
- If the version exists with different integrity, fail closed before any dry run or publish.
- If the version is absent, create the private snapshot, validate that snapshot with
  `npm publish --dry-run --json`, publish the same snapshot, and poll npm for matching
  readback as before.

The registry's published version is immutable, so a matching exact-version response is the
authoritative no-op result. The private snapshot is publication-only and is not needed for an
existing version after the source artifact's bytes have been independently verified.

## Error Handling

Malformed registry responses and integrity mismatches remain hard failures. Only the
existing E404 handling identifies an absent version. Ambiguous real-publish failures retain
the bounded readback behavior: a matching readback succeeds, while an absent readback
rethrows the original publish error.

## Testing

The regression test must model npm rejecting any duplicate-version dry run. It expects one
registry lookup, no dry-run call, no actual publish call, and an `already-published` result.
Existing tests continue to prove deterministic snapshot publication for absent versions,
fail-closed integrity comparison, and bounded post-publish readback.
