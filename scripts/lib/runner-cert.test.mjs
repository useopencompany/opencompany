import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectCertificate,
  parseSubjectAltNames,
  RUNNER_TLS_HOSTS,
  renewalReason,
  servedCertificateAction,
} from "./runner-cert.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function selfSigned({ hosts = RUNNER_TLS_HOSTS, days = 90 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "runner-cert-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-subj",
        `/CN=${hosts[0]}`,
        "-addext",
        `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}`,
        "-days",
        String(days),
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    return {
      certificatePem: readFileSync(join(dir, "cert.pem"), "utf8"),
      privateKeyPem: readFileSync(join(dir, "key.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const current = selfSigned();
const other = selfSigned();

test("accepts a certificate that covers every runner host with its own key", () => {
  const inspection = inspectCertificate(current);

  assert.deepEqual(inspection.problems, []);
  assert.deepEqual(inspection.hosts, RUNNER_TLS_HOSTS);
  assert.ok(inspection.daysLeft > 89 && inspection.daysLeft <= 90);
  assert.match(inspection.fingerprint, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/u);
});

test("reports a missing host, a foreign key and garbage", () => {
  const partial = selfSigned({ hosts: ["runner.opencompany.chat"] });
  assert.deepEqual(inspectCertificate(partial).problems, [
    "it does not cover work.opencompany.space, *.work.opencompany.space",
  ]);
  assert.deepEqual(
    inspectCertificate({
      certificatePem: current.certificatePem,
      privateKeyPem: other.privateKeyPem,
    }).problems,
    ["the private key does not match the certificate"],
  );
  assert.deepEqual(inspectCertificate({ certificatePem: "nope", privateKeyPem: "" }).problems, [
    "the certificate is not a PEM X.509 certificate",
  ]);
});

test("renews a month ahead, on request, or when the stored pair is unusable", () => {
  assert.equal(renewalReason(current), null);
  assert.equal(renewalReason({ ...current, force: true }), "forced by the workflow input");
  assert.equal(renewalReason({}), "Infisical /runner has no certificate");
  assert.equal(
    renewalReason({ ...current, now: new Date(Date.now() + 61 * DAY_MS) }),
    "it expires in 28 days",
  );
  assert.equal(
    renewalReason({ certificatePem: current.certificatePem, privateKeyPem: other.privateKeyPem }),
    "the private key does not match the certificate",
  );
});

test("forces a runner release only when kamal-proxy serves an expiring, replaced certificate", () => {
  const served = (daysLeft, fingerprint, hosts = RUNNER_TLS_HOSTS) => ({
    daysLeft,
    fingerprint,
    hosts,
  });
  const stored = (fingerprint, daysLeft = 89) => ({ fingerprint, daysLeft });
  assert.equal(servedCertificateAction({ served: null, stored: stored("A") }), "not-served");
  // Vercel's wildcard answers for runner.opencompany.chat until the cutover.
  assert.equal(
    servedCertificateAction({
      served: served(5, "V", ["*.opencompany.chat", "opencompany.chat"]),
      stored: stored("A"),
    }),
    "not-served",
  );
  assert.equal(servedCertificateAction({ served: served(40, "A"), stored: stored("B") }), "ok");
  assert.equal(
    servedCertificateAction({ served: served(9, "A"), stored: stored("B") }),
    "redeploy",
  );
  assert.equal(
    servedCertificateAction({ served: served(9, "A"), stored: stored("A", 9) }),
    "renewal-failed",
  );
});

test("an expired served certificate redeploys only when Infisical holds a current one", () => {
  const expired = { expired: true };
  assert.equal(
    servedCertificateAction({ served: expired, stored: { fingerprint: "B", daysLeft: 89 } }),
    "redeploy",
  );
  assert.equal(
    servedCertificateAction({ served: expired, stored: { fingerprint: "A", daysLeft: -1 } }),
    "renewal-failed",
  );
  assert.equal(
    servedCertificateAction({ served: expired, stored: { problems: ["x"] } }),
    "renewal-failed",
  );
});

test("parses SANs in Node's format", () => {
  assert.deepEqual(parseSubjectAltNames("DNS:*.opencompany.chat, DNS:opencompany.chat"), [
    "*.opencompany.chat",
    "opencompany.chat",
  ]);
  assert.deepEqual(parseSubjectAltNames(undefined), []);
});
