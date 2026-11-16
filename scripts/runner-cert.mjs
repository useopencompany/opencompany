#!/usr/bin/env node

// Called by: .github/workflows/renew-runner-cert.yml.
// Purpose: decides when the runner's TLS certificate needs renewing, stores a renewed one in
// Infisical prod `/runner`, and checks which certificate kamal-proxy serves.
//
//   node scripts/runner-cert.mjs plan
//   node scripts/runner-cert.mjs store --certificate <pem file> --key <pem file> [--dry-run]
//   node scripts/runner-cert.mjs check-served [--certificate <pem file>]

import { appendFileSync, readFileSync } from "node:fs";
import { connect } from "node:tls";
import { parseArgs } from "node:util";

import {
  inspectCertificate,
  parseSubjectAltNames,
  RUNNER_TLS_HOSTS,
  renewalReason,
  servedCertificateAction,
} from "./lib/runner-cert.mjs";

const [command, ...rest] = process.argv.slice(2);
const { values: options } = parseArgs({
  args: rest,
  options: {
    certificate: { type: "string" },
    key: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

try {
  if (command === "plan") plan();
  else if (command === "store") await store();
  else if (command === "check-served") await checkServed();
  else throw new Error(`Unknown command: ${command ?? "(none)"}. Use plan, store or check-served.`);
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function plan() {
  const reason = renewalReason({
    certificatePem: process.env.RUNNER_TLS_CERTIFICATE_PEM,
    privateKeyPem: process.env.RUNNER_TLS_PRIVATE_KEY_PEM,
    force: process.env.FORCE_RENEWAL === "true",
  });
  console.log(reason ? `Renewing: ${reason}.` : "The stored certificate is current.");
  writeOutput("renew", String(Boolean(reason)));
}

async function store() {
  if (!options.certificate || !options.key) throw new Error("store needs --certificate and --key.");
  const certificatePem = readFileSync(options.certificate, "utf8");
  const privateKeyPem = readFileSync(options.key, "utf8");
  const inspection = inspectCertificate({ certificatePem, privateKeyPem });
  if (inspection.problems.length > 0) {
    throw new Error(`The issued certificate is unusable: ${inspection.problems.join("; ")}.`);
  }
  console.log(`Issuer: ${inspection.issuer}`);
  console.log(`Hosts: ${inspection.hosts.join(", ")}`);
  console.log(`Expires: ${inspection.notAfter}`);
  console.log(`SHA-256 fingerprint: ${inspection.fingerprint}`);

  if (options["dry-run"]) {
    console.log("Dry run: Infisical keeps the current certificate.");
    return;
  }
  // The key first: until the certificate follows, the pair mismatches, preflight refuses it and
  // the next run renews again. Never the other way round with a certificate that looks current.
  const infisical = await infisicalClient();
  await infisical.upsert("RUNNER_TLS_PRIVATE_KEY_PEM", privateKeyPem);
  await infisical.upsert("RUNNER_TLS_CERTIFICATE_PEM", certificatePem);
  console.log("Stored the certificate and key in Infisical prod /runner.");
}

async function checkServed() {
  const storedPem = options.certificate
    ? readFileSync(options.certificate, "utf8")
    : process.env.RUNNER_TLS_CERTIFICATE_PEM;
  const stored = inspectCertificate({ certificatePem: storedPem, privateKeyPem: "" });
  const host = RUNNER_TLS_HOSTS[0];
  const served = await servedCertificate(host);
  const action = servedCertificateAction({ served, stored });

  if (served?.expired) {
    console.log(`${host} serves an expired certificate.`);
  } else if (served) {
    console.log(
      `${host} serves ${served.fingerprint} for ${served.hosts.join(", ")}, expiring ${served.notAfter} (${Math.floor(served.daysLeft)} days).`,
    );
  }
  if (action === "not-served") {
    // Before the cutover another server answers for the hostname, or none does. After it, Better
    // Stack's uptime monitor reports an unreachable runner long before the certificate matters.
    console.log(`::notice::${host} does not serve the runner certificate yet.`);
  } else if (action === "redeploy") {
    console.log("The served certificate is about to expire and Infisical holds a newer one.");
  } else if (action === "renewal-failed") {
    throw new Error(
      `${host} serves a certificate that ${served.expired ? "has expired" : `expires in ${Math.floor(served.daysLeft)} days`}, and Infisical holds no newer one. Renew it with force_renewal.`,
    );
  }
  writeOutput("action", action);
}

function servedCertificate(host) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 443, servername: host });
    socket.setTimeout(15_000, () => socket.destroy(new Error(`${host}:443 timed out.`)));
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      socket.end();
      const notAfter = new Date(certificate.valid_to);
      resolve({
        fingerprint: certificate.fingerprint256,
        hosts: parseSubjectAltNames(certificate.subjectaltname),
        notAfter: notAfter.toISOString(),
        daysLeft: (notAfter.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
      });
    });
    socket.once("error", (error) => {
      if (error.code === "ENOTFOUND") resolve(null);
      else if (error.code === "CERT_HAS_EXPIRED") resolve({ expired: true });
      else reject(new Error(`Could not read the certificate ${host} serves: ${error.message}`));
    });
  });
}

async function infisicalClient() {
  const domain = requiredEnv("INFISICAL_DOMAIN").replace(/\/+$/u, "");
  const environment = requiredEnv("INFISICAL_ENV_SLUG");
  const projectId = JSON.parse(
    readFileSync(new URL("../.infisical.json", import.meta.url), "utf8"),
  ).workspaceId;

  const login = await infisicalRequest(`${domain}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    body: {
      clientId: requiredEnv("INFISICAL_MACHINE_IDENTITY_CLIENT_ID"),
      clientSecret: requiredEnv("INFISICAL_MACHINE_IDENTITY_CLIENT_SECRET"),
    },
  });
  const headers = { Authorization: `Bearer ${login.body.accessToken}` };

  return {
    async upsert(name, value) {
      const url = `${domain}/api/v4/secrets/${encodeURIComponent(name)}`;
      const body = { projectId, environment, secretPath: "/runner", secretValue: value };
      let response = await infisicalRequest(url, {
        method: "PATCH",
        headers,
        body,
        allow404: true,
      });
      if (response.status === 404) {
        response = await infisicalRequest(url, { method: "POST", headers, body });
      }
      if (response.body?.approval) {
        throw new Error(`Infisical queued ${name} for approval instead of saving it.`);
      }
    },
  };
}

async function infisicalRequest(url, { method, headers = {}, body, allow404 = false }) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (allow404 && response.status === 404) return { status: 404, body: null };
  if (!response.ok) {
    // The response body can echo request fields; report only the status and path.
    throw new Error(`Infisical ${method} ${new URL(url).pathname} failed with ${response.status}.`);
  }
  return { status: response.status, body: await response.json() };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
