import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { renderSurfaceConfig } from "./release-orchestration.mjs";
import { surfaceConfig } from "./release-vercel.mjs";
import { RUNNER_TLS_HOSTS } from "./runner-cert.mjs";

const preflightUrl = new URL("../release-preflight.mjs", import.meta.url);
const appsUrl = new URL("../../apps/", import.meta.url);
const DEPLOY_ONLY_KEYS = ["KAMAL_REGISTRY_USERNAME", "KAMAL_REGISTRY_PASSWORD"];
const RUNNER_TLS_KEYS = ["RUNNER_TLS_CERTIFICATE_PEM", "RUNNER_TLS_PRIVATE_KEY_PEM"];
const renderUrl = new URL("../../render.yaml", import.meta.url);

test("production preflight follows the deployed runtime boundaries", async () => {
  const [source, render] = await Promise.all([
    readFile(preflightUrl, "utf8"),
    readFile(renderUrl, "utf8"),
  ]);
  const groups = readGroups(source);

  assertIncludes(groups.release.required, [
    "OPENCOMPANY_VERCEL_PROJECT_ID",
    "MARKETING_VERCEL_PROJECT_ID",
    "DOCS_VERCEL_PROJECT_ID",
  ]);

  assert.match(
    source,
    /requested\.length > 0 \? requested : \["web", "api", "runner", "release"\]/u,
    "the documented default preflight must include the release-only cutover gate",
  );

  assertIncludes(groups.web.required, [
    "DATABASE_URL",
    "BLOB_READ_WRITE_TOKEN",
    "OPENCOMPANY_DESKTOP_AUTH_SECRET",
    "BETTER_STACK_ERRORS_DSN",
    "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN",
    "OBSERVABILITY_ENABLED",
    "OBSERVABILITY_ENV",
    "NEXT_PUBLIC_OBSERVABILITY_ENABLED",
    "NEXT_PUBLIC_OBSERVABILITY_ENV",
  ]);
  assertExcludes(
    [...groups.web.required, ...groups.web.optional],
    [
      "OPENCOMPANY_AUTHKIT_DOMAIN",
      "OPENCOMPANY_STRIPE_API_KEY",
      "OPENCOMPANY_STRIPE_CHECKOUT_ENABLED",
      "OPENCOMPANY_STRIPE_WEBHOOK_SECRET",
      "ELECTRIC_URL",
      "VERCEL_AI_GATEWAY_API_KEY",
    ],
  );

  // The API and runner install the shared Bun exception reporter, so a missing DSN must fail
  // the release instead of silently downgrading to local-only error logs.
  assertIncludes(groups.api.required, [
    "BETTER_STACK_ERRORS_DSN",
    "WORKOS_MOBILE_CLIENT_ID",
    "GITHUB_USER_APP_SLUG",
    "GITHUB_USER_APP_CLIENT_ID",
    "GITHUB_USER_APP_CLIENT_SECRET",
    "SENTRY_APP_CLIENT_ID",
    "SENTRY_APP_CLIENT_SECRET",
    "SENTRY_APP_SLUG",
    "GITHUB_USER_APP_STATE_SECRET",
    "ELECTRIC_AUTH_MODE",
    "BUN_CONFIG_MAX_HTTP_REQUESTS",
  ]);

  assert.deepEqual(
    [...groups.electric.required],
    ["DATABASE_URL", "ELECTRIC_SECRET", "ELECTRIC_STORAGE_DIR", "ELECTRIC_REPLICATION_STREAM_ID"],
  );

  assertIncludes(groups.release.required, [
    "VM_SSH_PRIVATE_KEY",
    "VM_SSH_KNOWN_HOSTS",
    "VERCEL_DNS_API_TOKEN",
  ]);

  assertIncludes(groups.runner.required, [
    "RUNNER_PUBLIC_URL",
    "BETTER_STACK_ERRORS_DSN",
    "BLOB_READ_WRITE_TOKEN",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GITHUB_USER_APP_CLIENT_ID",
    "GITHUB_USER_APP_CLIENT_SECRET",
    "SENTRY_APP_CLIENT_ID",
    "SENTRY_APP_CLIENT_SECRET",
    "SENTRY_APP_SLUG",
    "MONID_API_KEY",
    "RUNNER_OPENCOMPANY_TASK_WORKER_ENABLED",
    "RUNNER_SANDBOX_NAMESPACE",
  ]);
  assertIncludes(groups.runner.optional, [
    "BROWSERBASE_API_KEY",
    "BROWSERBASE_PROJECT_ID",
    "OPENCOMPANY_BROWSER_PROFILES_ENABLED",
    "OPENCOMPANY_BROWSER_PROFILES_KILL_SWITCH",
  ]);
  assert.deepEqual(
    [...groups.runner.conditional].map((condition) => ({
      ...condition,
      require: [...condition.require],
    })),
    [
      {
        when: "OPENCOMPANY_BROWSER_PROFILES_ENABLED",
        equals: "true",
        require: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
      },
    ],
  );

  for (const [name, group] of Object.entries(groups)) {
    const keys = [...group.required, ...group.optional];
    assert.equal(new Set(keys).size, keys.length, `${name} preflight keys must be unique`);
  }

  assert.deepEqual([...surfaceConfig("web").requiredEnv].sort(), [...groups.web.required].sort());
  assert.deepEqual(readRenderKeys(render, "opencompany-api").sort(), groupKeys(groups.api).sort());
  assert.deepEqual(
    readRenderKeys(render, "opencompany-electric").sort(),
    groupKeys(groups.electric).sort(),
  );
  // Render supplies RENDER_EXTERNAL_URL instead of RUNNER_PUBLIC_URL, and only kamal-proxy reads
  // the TLS certificate.
  assert.deepEqual(
    readRenderKeys(render, "opencompany-runner").sort(),
    groupKeys(groups.runner)
      .filter((key) => key !== "RUNNER_PUBLIC_URL" && !RUNNER_TLS_KEYS.includes(key))
      .sort(),
  );
  assert.equal(
    readRenderShutdownDelay(render, "opencompany-api"),
    renderSurfaceConfig("api").maxShutdownDelaySeconds,
  );
  assert.equal(
    readRenderShutdownDelay(render, "opencompany-runner"),
    renderSurfaceConfig("runner").maxShutdownDelaySeconds,
  );
});

// Kamal ships a container exactly the keys `env.secret` lists, each read through .kamal/secrets
// from the deploy job's env. A key missing from one list never reaches the container, and a key
// missing from the preflight group is never checked before a deploy.
test("each Kamal config ships the keys its preflight group checks", async () => {
  const [source, render] = await Promise.all([
    readFile(preflightUrl, "utf8"),
    readFile(renderUrl, "utf8"),
  ]);
  const groups = readGroups(source);
  const [api, runner] = await Promise.all([readKamalApp("api"), readKamalApp("runner")]);

  for (const [name, app] of Object.entries({ api, runner })) {
    assert.equal(new Set(app.secret).size, app.secret.length, `${name} env.secret has duplicates`);
    assert.deepEqual(
      app.secret.filter((key) => Object.hasOwn(app.clear, key)),
      [],
      `${name} lists a key as clear and secret`,
    );
    assert.equal(app.clear.NODE_ENV, "production");
  }

  // The API reaches the Electric accessory through a clear ELECTRIC_URL, because Infisical `/api`
  // still syncs the Render Electric URL to the Render API.
  assert.equal(api.clear.ELECTRIC_URL, "http://opencompany-api-electric:3000");
  assert.deepEqual(
    sorted(api.secret),
    sorted(groupKeys(groups.api).filter((key) => key !== "ELECTRIC_URL")),
  );
  assert.deepEqual(
    sorted(api.secret),
    sorted(readRenderKeys(render, "opencompany-api").filter((key) => key !== "ELECTRIC_URL")),
  );
  assert.deepEqual(
    sorted(api.secretsFile),
    sorted([...DEPLOY_ONLY_KEYS, "ELECTRIC_DATABASE_URL", ...api.secret]),
  );

  assert.deepEqual(
    sorted(runner.secret),
    sorted(groupKeys(groups.runner).filter((key) => !RUNNER_TLS_KEYS.includes(key))),
  );
  assert.deepEqual(
    sorted(runner.secret),
    sorted([...readRenderKeys(render, "opencompany-runner"), "RUNNER_PUBLIC_URL"]),
  );
  assert.deepEqual(
    sorted(runner.secretsFile),
    sorted([...DEPLOY_ONLY_KEYS, ...RUNNER_TLS_KEYS, ...runner.secret]),
  );
  assert.deepEqual(runner.ssl, {
    certificate_pem: "RUNNER_TLS_CERTIFICATE_PEM",
    private_key_pem: "RUNNER_TLS_PRIVATE_KEY_PEM",
  });
  assert.deepEqual(runner.hosts, RUNNER_TLS_HOSTS);

  // The accessory takes `/electric` as Render's Electric does, with DATABASE_URL renamed by the
  // deploy job so it cannot collide with another folder's.
  const electric = api.accessories.electric;
  assert.deepEqual(sorted(electric.env.secret), [
    "DATABASE_URL:ELECTRIC_DATABASE_URL",
    "ELECTRIC_SECRET",
  ]);
  assert.deepEqual(
    sorted([
      ...electric.env.secret.map((key) => key.split(":")[0]),
      ...Object.keys(electric.env.clear),
    ]),
    sorted(groupKeys(groups.electric)),
  );
  assert.equal(electric.env.clear.ELECTRIC_REPLICATION_STREAM_ID, "opencompany_hetzner_v1");
  assert.equal(electric.image, readRenderElectricImage(render));
});

test("Render health checks are limited to web services", async () => {
  const services = readRenderServices(await readFile(renderUrl, "utf8"));

  for (const service of services) {
    if (!service.hasHealthCheckPath) continue;
    assert.equal(
      service.type,
      "web",
      `${service.name} is a ${service.type}; Render only accepts healthCheckPath on web services`,
    );
  }
});

function readGroups(source) {
  const startMarker = "const groups = ";
  const start = source.indexOf(startMarker);
  const end = source.indexOf("\n\n// Vercel projects", start);
  assert.notEqual(start, -1, "preflight groups declaration is missing");
  assert.notEqual(end, -1, "preflight groups terminator is missing");

  const objectSource = source.slice(start + startMarker.length, end).replace(/;\s*$/u, "");
  return vm.runInNewContext(`(${objectSource})`);
}

function assertIncludes(actual, expected) {
  for (const key of expected) assert.ok(actual.includes(key), `${key} should be in the preflight`);
}

function assertExcludes(actual, expected) {
  for (const key of expected) assert.ok(!actual.includes(key), `${key} should not be in the group`);
}

function readRenderKeys(render, serviceName) {
  const serviceStart = render.indexOf(`name: ${serviceName}`);
  const nextService = render.indexOf("\n  - type:", serviceStart);
  assert.notEqual(serviceStart, -1, `${serviceName} is missing from render.yaml`);
  const service = render.slice(serviceStart, nextService === -1 ? undefined : nextService);
  return [...service.matchAll(/^\s+- key: (?<key>[A-Z][A-Z0-9_]*)$/gmu)].map(
    (match) => match.groups.key,
  );
}

function readRenderShutdownDelay(render, serviceName) {
  const serviceStart = render.indexOf(`name: ${serviceName}`);
  const nextService = render.indexOf("\n  - type:", serviceStart);
  assert.notEqual(serviceStart, -1, `${serviceName} is missing from render.yaml`);
  const service = render.slice(serviceStart, nextService === -1 ? undefined : nextService);
  const match = service.match(/^\s+maxShutdownDelaySeconds:\s+(\d+)$/mu);
  assert.ok(match, `${serviceName} is missing maxShutdownDelaySeconds`);
  return Number(match[1]);
}

function readRenderServices(render) {
  return render
    .split(/(?=^  - type:)/gmu)
    .slice(1)
    .map((service) => ({
      type: service.match(/^  - type:\s+(\S+)$/mu)?.[1],
      name: service.match(/^    name:\s+(\S+)$/mu)?.[1],
      hasHealthCheckPath: /^    healthCheckPath:/mu.test(service),
    }));
}

async function readKamalApp(app) {
  const [deployYaml, secretsFile] = await Promise.all([
    readFile(new URL(`${app}/config/deploy.yml`, appsUrl), "utf8"),
    readFile(new URL(`${app}/.kamal/secrets`, appsUrl), "utf8"),
  ]);
  const deploy = parseDeployYaml(deployYaml);
  return {
    clear: deploy.env.clear,
    secret: deploy.env.secret,
    secretsFile: parseKamalSecrets(app, secretsFile),
    accessories: deploy.accessories ?? {},
    ssl: deploy.proxy.ssl,
    hosts: deploy.proxy.hosts,
  };
}

// Each line copies one variable from the job's env under its own name: `KEY=$KEY`. No values.
function parseKamalSecrets(app, text) {
  const keys = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=\$([A-Z][A-Z0-9_]*)$/u.exec(line);
    assert.ok(
      match && match[1] === match[2],
      `apps/${app}/.kamal/secrets: ${line} must be KEY=$KEY`,
    );
    assert.ok(!keys.includes(match[1]), `apps/${app}/.kamal/secrets maps ${match[1]} twice`);
    keys.push(match[1]);
  }
  return keys;
}

// Reads the YAML subset the Kamal configs use: nested maps, lists of scalars, quoted scalars and
// comments. Anything else fails, so the configs stay this simple or the test grows a parser.
function parseDeployYaml(text) {
  const lines = text
    .split("\n")
    .map((raw) => raw.replace(/\s+#.*$/u, "").replace(/^\s*#.*$/u, ""))
    .filter((line) => line.trim() !== "")
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
  let index = 0;

  function block(indent) {
    if (lines[index].text.startsWith("- ")) {
      const list = [];
      while (index < lines.length && lines[index].indent === indent) {
        assert.ok(lines[index].text.startsWith("- "), `unexpected YAML: ${lines[index].text}`);
        list.push(scalar(lines[index].text.slice(2)));
        index += 1;
      }
      return list;
    }
    const map = {};
    while (index < lines.length && lines[index].indent === indent) {
      const match = /^([\w-]+):(?:\s+(.*))?$/u.exec(lines[index].text);
      assert.ok(match, `unexpected YAML: ${lines[index].text}`);
      index += 1;
      if (match[2] !== undefined) map[match[1]] = scalar(match[2]);
      else if (index < lines.length && lines[index].indent > indent) {
        map[match[1]] = block(lines[index].indent);
      } else map[match[1]] = null;
    }
    return map;
  }

  const parsed = block(0);
  assert.equal(index, lines.length, `unexpected YAML indentation near: ${lines[index]?.text}`);
  return parsed;
}

function scalar(value) {
  const quoted = /^"(.*)"$/u.exec(value);
  return quoted ? quoted[1] : value;
}

function readRenderElectricImage(render) {
  const match = render.match(/^\s+url: (docker\.io\/electricsql\/electric@sha256:[a-f0-9]{64})$/mu);
  assert.ok(match, "render.yaml must pin the Electric image by digest");
  return match[1];
}

function sorted(keys) {
  return [...keys].sort();
}

function groupKeys(group) {
  return [
    ...new Set([
      ...group.required,
      ...group.optional,
      ...(group.conditional ?? []).flatMap((rule) => [rule.when, ...rule.require]),
    ]),
  ];
}
