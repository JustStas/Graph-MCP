import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

type WorkflowStep = {
  readonly name?: string;
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly shell?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
};

type WorkflowJob = {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly "runs-on"?: string;
  readonly "timeout-minutes"?: number;
  readonly environment?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly steps?: readonly WorkflowStep[];
};

type Workflow = {
  readonly name?: string;
  readonly on?: unknown;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly concurrency?: Readonly<Record<string, unknown>>;
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
};

type ConditionContext = {
  readonly eventName: string;
  readonly ref: string;
  readonly prepareOnly: boolean;
};

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(source: string): unknown };
const execFileAsync = promisify(execFile);
const workflowUrl = new URL("../.github/workflows/publish.yml", import.meta.url);
const packageJsonUrl = new URL("../package.json", import.meta.url);
const workflow = yaml.load(readFileSync(workflowUrl, "utf8")) as Workflow;
const checkoutAction = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
const setupNodeAction = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const uploadAction = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const downloadAction = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const packageCondition =
  "${{ github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') }}";
const publishCondition =
  "${{ github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.prepare_only != true) }}";
const temporaryDirectories = new Set<string>();

function getJob(name: "package" | "publish"): WorkflowJob {
  const job = workflow.jobs?.[name];
  if (!job) {
    throw new Error("Missing workflow job: " + name);
  }
  return job;
}

function getSteps(job: WorkflowJob): readonly WorkflowStep[] {
  if (!job.steps) {
    throw new Error("Workflow job is missing steps.");
  }
  return job.steps;
}

function getStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = getSteps(job).find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error("Missing workflow step: " + name);
  }
  return step;
}

function getRun(step: WorkflowStep): string {
  if (!step.run) {
    throw new Error("Workflow step is missing a run script: " + step.name);
  }
  return step.run;
}

function evaluateCondition(condition: string | undefined, context: ConditionContext): boolean {
  if (condition === packageCondition) {
    return (
      context.eventName === "release" ||
      (context.eventName === "workflow_dispatch" && context.ref === "refs/heads/main")
    );
  }
  if (condition === publishCondition) {
    return (
      context.eventName === "release" ||
      (context.eventName === "workflow_dispatch" &&
        context.ref === "refs/heads/main" &&
        context.prepareOnly !== true)
    );
  }
  throw new Error("Unexpected workflow condition: " + condition);
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "graph-mcp-workflow-"));
  temporaryDirectories.add(directory);
  return directory;
}

async function executeShellScript(
  script: string,
  environment: Readonly<Record<string, string>>,
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const directory = await createTemporaryDirectory();
  const outputPath = join(directory, "github-output");
  try {
    await execFileAsync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: directory,
      env: { ...process.env, ...environment, GITHUB_OUTPUT: outputPath },
    });
    return { exitCode: 0, output: await readFile(outputPath, "utf8").catch(() => "") };
  } catch (error) {
    const exitCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number"
        ? error.code
        : 1;
    return { exitCode, output: await readFile(outputPath, "utf8").catch(() => "") };
  }
}

async function executeNpmGate(script: string, npmVersion: string): Promise<number> {
  const directory = await createTemporaryDirectory();
  const npmPath = join(directory, "npm");
  await writeFile(npmPath, '#!/bin/sh\nprintf "%s\\n" "$FAKE_NPM_VERSION"\n', "utf8");
  await chmod(npmPath, 0o755);
  try {
    await execFileAsync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: directory,
      env: {
        ...process.env,
        FAKE_NPM_VERSION: npmVersion,
        PATH: directory + ":" + process.env.PATH,
      },
    });
    return 0;
  } catch (error) {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number"
      ? error.code
      : 1;
  }
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
      temporaryDirectories.delete(directory);
    }),
  );
});

describe("npm publish workflow", () => {
  const packageJob = getJob("package");
  const publishJob = getJob("publish");

  test("declares the semantic YAML parser as an exact direct dependency", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      readonly devDependencies?: Readonly<Record<string, string>>;
    };
    expect(packageJson.devDependencies?.["js-yaml"]).toBe("4.3.0");
  });

  test("uses only the exact release and controlled manual triggers", () => {
    expect(workflow.on).toEqual({
      release: { types: ["published"] },
      workflow_dispatch: {
        inputs: {
          tag: {
            description: "Existing release tag to package",
            required: true,
            type: "string",
          },
          prepare_only: {
            description: "Build and upload the tarball without publishing",
            required: true,
            default: false,
            type: "boolean",
          },
        },
      },
    });
    expect(workflow.concurrency).toEqual({
      group: "npm-publish-${{ github.repository }}",
      "cancel-in-progress": false,
    });
  });

  test("uses exact job conditions for release and main-only manual execution", () => {
    expect(packageJob.if).toBe(packageCondition);
    expect(publishJob.if).toBe(publishCondition);
  });

  test.each([
    {
      label: "release tag",
      context: { eventName: "release", ref: "refs/tags/v1.2.3", prepareOnly: true },
      packageRuns: true,
      publishRuns: true,
    },
    {
      label: "manual main publication",
      context: { eventName: "workflow_dispatch", ref: "refs/heads/main", prepareOnly: false },
      packageRuns: true,
      publishRuns: true,
    },
    {
      label: "manual main preparation",
      context: { eventName: "workflow_dispatch", ref: "refs/heads/main", prepareOnly: true },
      packageRuns: true,
      publishRuns: false,
    },
    {
      label: "manual non-main publication",
      context: { eventName: "workflow_dispatch", ref: "refs/heads/topic", prepareOnly: false },
      packageRuns: false,
      publishRuns: false,
    },
  ])("enforces the $label truth-table row", ({ context, packageRuns, publishRuns }) => {
    expect(evaluateCondition(packageJob.if, context)).toBe(packageRuns);
    expect(evaluateCondition(publishJob.if, context)).toBe(publishRuns);
  });

  test("uses exact runners, timeouts, outputs, environment, and effective permissions", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.permissions).not.toHaveProperty("id-token");
    expect(packageJob["runs-on"]).toBe("ubuntu-latest");
    expect(packageJob["timeout-minutes"]).toBe(25);
    expect(packageJob.outputs).toEqual({
      artifact_name: "${{ steps.metadata.outputs.artifact_name }}",
    });
    expect(packageJob.env).toEqual({
      RELEASE_TAG: "${{ github.event.release.tag_name || inputs.tag }}",
    });
    expect(packageJob.permissions).toBeUndefined();
    expect(publishJob.needs).toBe("package");
    expect(publishJob["runs-on"]).toBe("ubuntu-latest");
    expect(publishJob["timeout-minutes"]).toBe(10);
    expect(publishJob.environment).toBe("npm");
    expect(publishJob.env).toEqual({
      EXPECTED_RELEASE_TAG: "${{ github.event.release.tag_name || inputs.tag }}",
    });
    expect(publishJob.permissions).toEqual({
      actions: "read",
      contents: "read",
      "id-token": "write",
    });
    expect(JSON.stringify(packageJob)).not.toContain("id-token");
  });

  test("uses the exact pinned action multiset and no other action", () => {
    const uses = Object.values(workflow.jobs ?? {}).flatMap((job) =>
      getSteps(job)
        .map((step) => step.uses)
        .filter((value): value is string => value !== undefined),
    );
    const expectedUses = [
      checkoutAction,
      checkoutAction,
      setupNodeAction,
      setupNodeAction,
      uploadAction,
      downloadAction,
    ];
    expect([...uses].sort()).toEqual([...expectedUses].sort());
    expect(uses.every((value) => /@[a-f0-9]{40}$/.test(value))).toBe(true);
  });

  test("checks out only the qualified tag without persisted credentials", () => {
    const checkout = getStep(packageJob, "Check out release tag");
    expect(checkout.uses).toBe(checkoutAction);
    expect(checkout.with).toEqual({
      ref: "refs/tags/${{ steps.release.outputs.tag }}",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
  });

  test("checks out the trusted publish helper at the workflow SHA", () => {
    const checkout = getStep(publishJob, "Check out trusted publish helper");
    expect(checkout.uses).toBe(checkoutAction);
    expect(checkout.with).toEqual({
      ref: "${{ github.workflow_sha }}",
      path: "trusted-source",
      "persist-credentials": false,
    });
  });

  test.each([
    ["v0.0.0", true],
    ["v10.20.30", true],
    ["v01.2.3", false],
    ["v1.2.3-beta.1", false],
    ["v1.2.3\ninjected=value", false],
    ["1.2.3", false],
  ])("validates release tag %j before writing workflow output", async (tag, accepted) => {
    const result = await executeShellScript(getRun(getStep(packageJob, "Resolve release tag")), {
      RELEASE_TAG: tag,
    });
    expect(result.exitCode === 0).toBe(accepted);
    expect(result.output).toBe(accepted ? "tag=" + tag + "\n" : "");
  });

  test("runs a trusted commit and ancestry preflight before dependencies or repository code", () => {
    const names = getSteps(packageJob).map((step) => step.name);
    expect(names).toEqual([
      "Resolve release tag",
      "Check out release tag",
      "Fetch main ancestry",
      "Verify trusted release commit",
      "Set up Node.js",
      "Require OIDC-capable npm",
      "Install locked dependencies",
      "Verify source and package",
      "Prepare release tarball",
      "Validate release metadata",
      "Upload release tarball",
    ]);
    const preflight = getRun(getStep(packageJob, "Verify trusted release commit"));
    expect(preflight).toContain('git rev-parse --verify "refs/tags/$RELEASE_TAG^{commit}"');
    expect(preflight).toContain("git rev-parse --verify HEAD");
    expect(preflight).toContain('[[ "$tag_commit" != "$head_commit" ]]');
    expect(preflight).toContain('git merge-base --is-ancestor "$tag_commit" origin/main');
  });

  test("validates strict package metadata and exposes only strict outputs", () => {
    const metadataStep = getStep(packageJob, "Validate release metadata");
    const run = getRun(metadataStep);
    expect(metadataStep.id).toBe("metadata");
    expect(run).toContain('const expectedName = "@juststas/graph-mcp"');
    expect(run).toContain("metadata.tag !== process.env.RELEASE_TAG");
    expect(run).toContain('metadata.tag !== "v" + metadata.version');
    expect(run).toContain("const expectedFilename = `juststas-graph-mcp-${metadata.version}.tgz`");
    expect(run).toContain('await access(join("release", expectedFilename))');
    expect(run).toContain("printf 'artifact_name=npm-package-%s\\n'");
    expect(run).not.toContain("release_tag=");
  });

  test("uploads only the tarball and metadata data files", () => {
    const upload = getStep(packageJob, "Upload release tarball");
    const paths = String(upload.with?.path)
      .trim()
      .split("\n")
      .map((value) => value.trim());
    expect(upload.uses).toBe(uploadAction);
    expect(upload.with).toEqual({
      name: "${{ steps.metadata.outputs.artifact_name }}",
      path: "release/*.tgz\nrelease/package-metadata.json\n",
      "if-no-files-found": "error",
      "retention-days": 1,
    });
    expect(paths).toEqual(["release/*.tgz", "release/package-metadata.json"]);
    expect(paths.every((value) => !value.endsWith(".mjs"))).toBe(true);
  });

  test("downloads the named data artifact and validates its release identity", () => {
    const names = getSteps(publishJob).map((step) => step.name);
    expect(names).toEqual([
      "Check out trusted publish helper",
      "Set up Node.js",
      "Require OIDC-capable npm",
      "Download release tarball",
      "Validate downloaded release metadata",
      "Publish or verify immutable version",
    ]);
    const download = getStep(publishJob, "Download release tarball");
    expect(download.uses).toBe(downloadAction);
    expect(download.with).toEqual({
      name: "${{ needs.package.outputs.artifact_name }}",
      path: "release",
    });
    const validation = getStep(publishJob, "Validate downloaded release metadata");
    expect(validation.env).toBeUndefined();
    const run = getRun(validation);
    expect(run).toContain('metadata.name !== "@juststas/graph-mcp"');
    expect(run).toContain("metadata.tag !== process.env.EXPECTED_RELEASE_TAG");
    expect(run).toContain('metadata.tag !== "v" + metadata.version');
    expect(JSON.stringify(workflow)).not.toContain("needs.package.outputs.release_tag");
  });

  test("publishes through the workflow-SHA helper and never downloaded executable code", () => {
    const publishRun = getRun(getStep(publishJob, "Publish or verify immutable version"));
    expect(publishRun).toBe(
      'node trusted-source/scripts/release-package.mjs publish release/package-metadata.json "$EXPECTED_RELEASE_TAG"',
    );
    expect(JSON.stringify(publishJob)).not.toContain("node release/release-package.mjs");
    expect(JSON.stringify(publishJob)).not.toContain("npm ci");
    expect(JSON.stringify(publishJob)).not.toContain("npm run verify");
  });

  test.each([
    ["11.5.0", false],
    ["11.5.1", true],
    ["11.5.1-beta.0", false],
    ["malformed", false],
    ["12.0.0", true],
  ])("requires exact stable npm boundary for %s", async (version, accepted) => {
    const results = await Promise.all(
      [packageJob, publishJob].map(async (job) => {
        const gate = getRun(getStep(job, "Require OIDC-capable npm"));
        return (await executeNpmGate(gate, version)) === 0;
      }),
    );
    expect(results).toEqual([accepted, accepted]);
  });

  test("contains no long-lived credential reference in semantic workflow values", () => {
    expect(JSON.stringify(workflow)).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
  });
});
