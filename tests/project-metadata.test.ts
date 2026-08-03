import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

function sectionBetween(document: string, start: string, end: string): string {
  const startIndex = document.indexOf(start);
  const endIndex = document.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return document.slice(startIndex, endIndex);
}

function expectMarkersInOrder(document: string, markers: readonly string[]): void {
  const normalizedDocument = document.replace(/\s+/g, " ");
  let cursor = 0;
  for (const marker of markers) {
    const normalizedMarker = marker.replace(/\s+/g, " ");
    const index = normalizedDocument.indexOf(normalizedMarker, cursor);
    expect(index, `missing or out-of-order marker: ${marker}`).toBeGreaterThanOrEqual(cursor);
    cursor = index + normalizedMarker.length;
  }
}

describe("package metadata", () => {
  test("publishes an ESM Node 22 CLI as graph-mcp", async () => {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const pkg: unknown = JSON.parse(await readFile(packageJsonUrl, "utf8"));
    expect(pkg).toMatchObject({
      name: "@juststas/graph-mcp",
      version: "0.7.0",
      type: "module",
      bin: { "graph-mcp": "dist/cli.js" },
      repository: {
        type: "git",
        url: "git+https://github.com/JustStas/Graph-MCP.git",
      },
      publishConfig: { access: "public" },
      engines: { node: ">=22" },
      dependencies: { "@modelcontextprotocol/sdk": "1.30.0" },
    });
  });

  test("documents the scoped package while preserving the graph-mcp command", async () => {
    const [readme, changelog] = await Promise.all([
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
    ]);
    const releaseProcedure = sectionBetween(
      readme,
      "### Release procedure",
      "## Architecture and runtime behavior",
    );
    const normalRelease = sectionBetween(
      releaseProcedure,
      "#### Normal releases",
      "#### First scoped-package bootstrap",
    );
    const bootstrap = sectionBetween(
      releaseProcedure,
      "#### First scoped-package bootstrap",
      "#### Recovery",
    );
    const recovery = releaseProcedure.slice(releaseProcedure.indexOf("#### Recovery"));
    const normalizedBootstrap = bootstrap.replace(/\s+/g, " ");
    const normalizedRecovery = recovery.replace(/\s+/g, " ");

    expect(readme).toContain("npm install --global @juststas/graph-mcp");
    expect(readme).toContain("graph-mcp setup");
    expectMarkersInOrder(releaseProcedure, [
      "Graph MCP releases use",
      "`graph-mcp@0.6.0`",
      "Version 0.6.1 is the first scoped npm release",
      "#### Normal releases",
      "#### First scoped-package bootstrap",
      "#### Recovery",
    ]);
    expectMarkersInOrder(normalRelease, [
      "Update `package.json`",
      "Run `npm ci`, `npm run verify`",
      "Merge the reviewed pull request",
      "release-tag authority",
      "no-bypass immutability",
      "Publish the matching GitHub Release",
      "release: types: [published]",
      "The package job",
      "without OIDC permission",
      "The publish job",
      "only job that receives OIDC permission",
      "data-only artifact containing the tarball and metadata",
      "`github.workflow_sha`",
      "npm Trusted Publishing",
      "Verify the workflow",
    ]);
    expect(bootstrap).toContain("npm requires a package to exist");
    expectMarkersInOrder(bootstrap, [
      "activate the administrator-authority `v*` ruleset",
      "Audit the exact historical tag inventory",
      "Activate the separate no-bypass immutability ruleset",
      "Create the annotated `v0.6.1` tag",
      "with `prepare_only` enabled",
      "Validate the exact filename",
      "Publish that same private snapshot",
      "interactive 2FA",
      "Reverify both release-tag rulesets",
      "Create the `npm` GitHub environment",
      "Add separate typed environment policies",
      "Verify both rulesets and both typed environment policies",
      "Configure npm Trusted Publishing",
    ]);
    expect(normalizedBootstrap).toContain(
      "manual 0.6.1 bootstrap uses neither OIDC nor provenance",
    );
    expect(normalizedBootstrap).toContain("Version 0.6.2 is the first real OIDC publish");
    expect(normalizedRecovery).toContain(
      "`workflow_dispatch` from `main` with an existing protected tag",
    );
    expect(normalizedRecovery).toContain("prohibit moving or deleting published `v*` tags");
    expect(normalizedRecovery).toContain("new patch release");
    expect(changelog).toContain("Changed the npm package identity to @juststas/graph-mcp");
    expect(changelog).toContain("0.6.1 is the first scoped npm release");
    expect(changelog).not.toContain("- Published the npm distribution");

    expect(readme).not.toMatch(/^npm install --global graph-mcp(?:\s|$)/m);
    expect(readme).not.toMatch(/^npm (?:publish|view) graph-mcp(?:@|\s|$)/m);
    expect(readme).not.toMatch(/^npm publish(?:\s+--access public|\s+\.)/m);
    expect(readme).not.toMatch(
      /^(?:python(?:3)? -m build|twine upload|poetry publish|pip install graph-mcp)\b/m,
    );
    expect(readme).not.toContain("versions are all `0.6.0`");
  });
});
