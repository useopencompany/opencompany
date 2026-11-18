import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../.github/workflows/release-production.yml", import.meta.url);
const vercelConfigUrls = ["web", "marketing", "docs"].map(
  (surface) => new URL(`../../apps/${surface}/vercel.json`, import.meta.url),
);

test("disables Vercel Git deployments for every CI-owned project", async () => {
  for (const configUrl of vercelConfigUrls) {
    const config = JSON.parse(await readFile(configUrl, "utf8"));
    assert.equal(config.git?.deploymentEnabled, false, `${configUrl} must be CI-owned`);
  }
});

test("verifies the exact main commit before release planning and production", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assertStepOrder(workflow, ["context:", "verify:", "plan:", "release:"]);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/verify\.yml/u);
  assert.match(workflow, /head_sha: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /^ {2}plan:\n[\s\S]*?needs: verify/mu);
  assert.match(workflow, /^ {2}release:\n[\s\S]*?needs: \[plan, build-images\]/mu);
  assert.doesNotMatch(workflow, /workflow_run:/u);
});

test("builds Vercel outputs before migrations and rechecks main before deploys", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assertStepOrder(workflow, [
    "Confirm release is current before preparation",
    "Prepare web deployment",
    "Prepare marketing deployment",
    "Prepare docs deployment",
    "Export API secrets for Kamal",
    "Export runner secrets for Kamal",
    "Load the deploy key into ssh-agent",
    "Trust the server's host keys",
    "Confirm release is current before production changes",
    "Run production migrations",
    "Canonicalize wiki path links",
    "Confirm release is current before provider deploys",
    "Deploy and smoke marketing",
    "Deploy and smoke docs",
    "Deploy and smoke Kamal services",
    "Release the Kamal deploy locks",
    "Deploy web",
    "Smoke web release",
    "Activate Personal Skills and plugins after old services drain",
  ]);
  assert.doesNotMatch(workflow, /node <<['"]?NODE/u);
  assert.match(workflow, /timeout-minutes: 45/u);
  assert.match(workflow, /VERCEL_DEPLOY_TIMEOUT_MS: "600000"/u);
  assert.match(workflow, /run: bun scripts\/backfill-wiki-path-links\.ts/u);
  assert.match(workflow, /run: node scripts\/activate-personal-skills\.mjs/u);
  const preparationGate = workflow.slice(
    workflow.indexOf("- name: Confirm release is current before preparation"),
    workflow.indexOf("- name: Confirm release is current before production changes"),
  );
  assert.match(
    preparationGate,
    /steps\.current-before-prepare\.outputs\.should_release == 'true'/u,
  );
  const activation = workflow.slice(
    workflow.indexOf("- name: Activate Personal Skills and plugins"),
    workflow.indexOf("- name: Finalize database deployment"),
  );
  assert.match(activation, /steps\.smoke-web\.outcome == 'success'/u);
  const deployWeb = workflow.slice(
    workflow.indexOf("- name: Deploy web"),
    workflow.indexOf("- name: Smoke web release"),
  );
  assert.doesNotMatch(deployWeb, /steps\.activate-personal-skills/u);
  assert.match(
    workflow,
    /steps\.migrate\.outcome == 'success' && steps\.backfill-wiki-path-links\.outcome == 'success'/u,
  );
});

test("serializes only the production mutation stage", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const releaseStart = workflow.indexOf("  release:\n");
  const beforeRelease = workflow.slice(0, releaseStart);
  const release = workflow.slice(releaseStart);

  assert.doesNotMatch(beforeRelease, /group: production-release/u);
  assert.match(
    release,
    /concurrency:\n {6}group: production-release\n {6}queue: max\n {6}cancel-in-progress: false/u,
  );
});

test("tracks and finalizes every production surface independently", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  for (const surface of ["database", "api", "runner", "web", "marketing", "docs"]) {
    assert.match(workflow, new RegExp(`create --surface ${surface}`, "u"));
    assert.match(workflow, new RegExp(`finalize --surface ${surface}`, "u"));
  }
  assert.match(workflow, /steps\.deploy-kamal\.outputs\.api_result == 'success'/u);
  assert.match(workflow, /steps\.deploy-kamal\.outputs\.runner_result == 'success'/u);
  assert.match(workflow, /state=inactive/u);
});

test("does not fail a release that a newer main commit superseded", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const resultGate = workflow.slice(workflow.indexOf("- name: Require every selected surface"));

  assert.match(
    resultGate,
    /if: \$\{\{ always\(\) && !cancelled\(\) && steps\.current-before-deploy\.outputs\.should_release == 'true' \}\}/u,
  );
  assert.doesNotMatch(resultGate, /steps\.current-before-migration\.outputs\.should_release/u);
});

test("production credentials are scoped to the release job", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const releaseStart = workflow.indexOf("  release:\n");
  const beforeRelease = workflow.slice(0, releaseStart);
  const release = workflow.slice(releaseStart);

  assert.doesNotMatch(beforeRelease, /environment: production/u);
  assert.doesNotMatch(beforeRelease, /secrets\.INFISICAL_/u);
  assert.match(release, /environment: production/u);
  assert.doesNotMatch(workflow, /id-token: write/u);
  assert.match(release, /deployments: write/u);
});

test("pins production secret access to the self-hosted Infisical project", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /INFISICAL_DOMAIN: "https:\/\/infisical\.opencompany\.cloud"/u);
  assert.match(workflow, /INFISICAL_PROJECT_SLUG: "opencompany-xqub"/u);
  assert.equal(workflow.match(/method: universal/gu)?.length, 10);
  assert.equal(
    workflow.match(/client-id: \$\{\{ secrets\.INFISICAL_MACHINE_IDENTITY_CLIENT_ID \}\}/gu)
      ?.length,
    10,
  );
  assert.equal(
    workflow.match(/client-secret: \$\{\{ secrets\.INFISICAL_MACHINE_IDENTITY_CLIENT_SECRET \}\}/gu)
      ?.length,
    10,
  );
  assert.doesNotMatch(workflow, /method: oidc|identity-id:|vars\.INFISICAL_/u);
});

test("retries bounded Infisical secret fetches before changing production", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  for (const [first, retryName, id] of [
    [
      "Fetch release secrets from Infisical",
      "Retry release secrets from Infisical",
      "infisical-release-secrets",
    ],
    [
      "Fetch API secrets from Infisical",
      "Retry API secrets from Infisical",
      "infisical-api-secrets",
    ],
    [
      "Fetch runner secrets from Infisical",
      "Retry runner secrets from Infisical",
      "infisical-runner-secrets",
    ],
    ["Export API secrets for Kamal", "Retry API secrets for Kamal", "kamal-api-secrets"],
    ["Export runner secrets for Kamal", "Retry runner secrets for Kamal", "kamal-runner-secrets"],
  ]) {
    const firstAttempt = workflow.slice(
      workflow.indexOf(`- name: ${first}`),
      workflow.indexOf(`- name: ${retryName}`),
    );
    assert.match(firstAttempt, new RegExp(`id: ${id}`, "u"));
    assert.match(firstAttempt, /continue-on-error: true/u);
    assert.match(firstAttempt, /timeout-minutes: 2/u);

    const retryStart = workflow.indexOf(`- name: ${retryName}`);
    assert.ok(retryStart >= 0, `missing ${retryName}`);
    const retry = workflow.slice(retryStart, workflow.indexOf("\n      - name:", retryStart + 1));
    assert.match(retry, new RegExp(`steps\\.${id}\\.outcome == 'failure'`, "u"));
    assert.match(retry, /timeout-minutes: 2/u);
  }
});

test("builds both images before the release job and blocks the release on a failed build", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const build = jobBlock(workflow, "build-images");
  const release = jobBlock(workflow, "release");

  assertStepOrder(workflow, ["plan:", "build-images:", "release:"]);
  assert.match(build, /needs: plan/u);
  assert.match(build, /app: \[api, runner\]/u);
  assert.match(build, /fail-fast: false/u);
  assert.match(build, /SELECTED: \$\{\{ needs\.plan\.outputs\[matrix\.app\] \}\}/u);
  assert.match(build, /packages: write/u);
  assert.match(build, /useblacksmith\/setup-docker-builder@[a-f0-9]{40}/u);
  assert.match(build, /working-directory: apps\/\$\{\{ matrix\.app \}\}/u);
  assert.match(build, /VERSION: \$\{\{ env\.RELEASE_SHA \}\}\n {8}run: kamal build push/u);
  assert.doesNotMatch(build, /environment:|secrets\.|run: kamal deploy/u);

  assert.match(
    release,
    /if: \$\{\{ !cancelled\(\) && needs\.plan\.result == 'success' && needs\.plan\.outputs\.any == 'true' && needs\.build-images\.result != 'failure' \}\}/u,
  );
  assert.match(release, /packages: read/u);
  assert.doesNotMatch(release, /packages: write/u);
});

test("deploys each Kamal app from its own Infisical export, never with kamal setup", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const release = jobBlock(workflow, "release");

  for (const [folder, file] of [
    ["/api", ".env.release-kamal-api"],
    ["/runner", ".env.release-kamal-runner"],
  ]) {
    assert.match(
      release,
      new RegExp(
        `secret-path: ${folder}\\n {10}export-type: file\\n {10}file-output-path: /${file.replaceAll(".", "\\.")}`,
        "u",
      ),
    );
  }
  assert.match(release, /\n {10}node scripts\/release-kamal-services\.mjs "\$\{args\[@\]\}"/u);
  assert.doesNotMatch(workflow, /kamal setup/u);
  assert.match(release, /ssh-add - <<< "\$VM_SSH_PRIVATE_KEY"/u);
  assert.match(release, /"\$VM_SSH_KNOWN_HOSTS" >> ~\/\.ssh\/known_hosts/u);

  const lockRelease = release.slice(
    release.indexOf("- name: Release the Kamal deploy locks"),
    release.indexOf("- name: Deploy web"),
  );
  assert.match(lockRelease, /if: \$\{\{ cancelled\(\)/u);
  assert.match(lockRelease, /kamal lock release/u);
  assert.match(lockRelease, /API_SELECTED: \$\{\{ needs\.plan\.outputs\.api \}\}/u);
  assert.match(lockRelease, /RUNNER_SELECTED: \$\{\{ needs\.plan\.outputs\.runner \}\}/u);

  const cleanup = release.slice(release.indexOf("- name: Remove Kamal env files"));
  assert.match(cleanup, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(cleanup, /rm -f "\$KAMAL_API_ENV_FILE" "\$KAMAL_RUNNER_ENV_FILE"/u);
});

function jobBlock(workflow, job) {
  const block = workflow
    .split(/^(?= {2}[a-z][\w-]*:$)/mu)
    .find((candidate) => candidate.startsWith(`  ${job}:\n`));
  assert.ok(block, `missing ${job} job`);
  return block;
}

function assertStepOrder(workflow, markers) {
  let previousIndex = -1;
  for (const marker of markers) {
    const needle = marker.endsWith(":") ? `  ${marker}` : `- name: ${marker}`;
    const index = workflow.indexOf(needle);
    assert.ok(index > previousIndex, `${marker} must follow the preceding workflow marker`);
    previousIndex = index;
  }
}
