import assert from "node:assert/strict";
import test from "node:test";

import { kamalDeployArgs, kamalDeployEnv, parseInfisicalEnvFile } from "./release-kamal.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const jobEnv = {
  PATH: "/usr/bin",
  HOME: "/home/runner",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  KAMAL_REGISTRY_USERNAME: "github-actions",
  KAMAL_REGISTRY_PASSWORD: "ghs_token",
  DATABASE_URL: "postgres://migration",
  API_DATABASE_URL: "postgres://job-api",
  PRODUCTION_DATABASE_URL: "postgres://migration",
  VERCEL_TOKEN: "vercel-token",
  VERCEL_ORG_ID: "team_1",
  OPENCOMPANY_VERCEL_PROJECT_ID: "project_1",
};

test("parses Infisical file exports, including quotes and multi-line values", () => {
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
  const text = [
    "RUNNER_PUBLIC_URL='https://runner.opencompany.chat'",
    `RUNNER_TLS_CERTIFICATE_PEM='${pem}'`,
    "QUOTED='it's = fine'",
    "EMPTY=''",
  ].join("\n");

  assert.deepEqual(parseInfisicalEnvFile(text), {
    RUNNER_PUBLIC_URL: "https://runner.opencompany.chat",
    RUNNER_TLS_CERTIFICATE_PEM: pem,
    QUOTED: "it's = fine",
    EMPTY: "",
  });
  assert.deepEqual(parseInfisicalEnvFile(""), {});
});

test("rejects an Infisical export it cannot read", () => {
  assert.throws(() => parseInfisicalEnvFile("KEY=unquoted"), /Unreadable Infisical export/u);
  assert.throws(() => parseInfisicalEnvFile("A='1'\nA='2'"), /lists A twice/u);
});

test("builds the runner env from its folder plus the release-owned Vercel credentials", () => {
  const env = kamalDeployEnv({
    app: "runner",
    jobEnv,
    appSecrets: {
      DATABASE_URL: "postgres://runner",
      PATH: "/hijack",
      RUNNER_PUBLIC_URL: "x",
    },
  });

  assert.equal(env.DATABASE_URL, "postgres://runner");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.API_DATABASE_URL, undefined);
  assert.equal(env.PRODUCTION_DATABASE_URL, undefined);
  assert.equal(env.SSH_AUTH_SOCK, "/tmp/agent.sock");
  assert.equal(env.KAMAL_REGISTRY_PASSWORD, "ghs_token");
  assert.equal(env.VERCEL_TOKEN, "vercel-token");
  assert.equal(env.VERCEL_ORG_ID, "team_1");
  assert.equal(env.OPENCOMPANY_VERCEL_PROJECT_ID, "project_1");
});

test("keeps /electric and the migration URL out of the API deploy", () => {
  const env = kamalDeployEnv({
    app: "api",
    jobEnv,
    appSecrets: { API_DATABASE_URL: "postgres://api" },
  });

  assert.equal(env.API_DATABASE_URL, "postgres://api");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.ELECTRIC_DATABASE_URL, undefined);
  assert.equal(env.VERCEL_TOKEN, undefined);
});

test("requires the deploy key and registry login from the job", () => {
  assert.throws(
    () =>
      kamalDeployEnv({
        app: "runner",
        jobEnv: { ...jobEnv, SSH_AUTH_SOCK: undefined },
        appSecrets: { SSH_AUTH_SOCK: "/from/infisical" },
      }),
    /SSH_AUTH_SOCK is required/u,
  );
  assert.throws(() => kamalDeployEnv({ app: "web", jobEnv, appSecrets: {} }), /Unknown Kamal app/u);
});

test("deploys the pushed image for the exact release commit", () => {
  assert.deepEqual(kamalDeployArgs(SHA), ["deploy", "--skip-push", "--version", SHA]);
  assert.throws(() => kamalDeployArgs("0123456"), /full commit SHA/u);
});
