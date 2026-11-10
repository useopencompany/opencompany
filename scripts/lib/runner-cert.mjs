// The runner's TLS certificate: kamal-proxy serves it for every runner hostname, and Let's
// Encrypt's HTTP challenge cannot issue the wildcard, so .github/workflows/renew-runner-cert.yml
// issues it with a DNS challenge. apps/runner/config/deploy.yml must list the same hosts.
import { createPrivateKey, X509Certificate } from "node:crypto";

export const RUNNER_TLS_HOSTS = [
  "runner.opencompany.chat",
  "work.opencompany.space",
  "*.work.opencompany.space",
];

// Renew a month ahead, like certbot. The release preflight refuses a certificate with a week or
// less left, and the workflow forces a runner release when the served one has 10 days or less.
export const RENEW_WITHIN_DAYS = 30;
export const PREFLIGHT_MIN_DAYS = 7;
export const REDEPLOY_WITHIN_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

// Reads a certificate and its key without throwing: `problems` lists everything wrong.
export function inspectCertificate({ certificatePem, privateKeyPem, now = new Date() }) {
  const problems = [];
  let certificate = null;
  try {
    certificate = new X509Certificate(certificatePem ?? "");
  } catch {
    return { problems: ["the certificate is not a PEM X.509 certificate"] };
  }

  const notAfter = new Date(certificate.validTo);
  const daysLeft = (notAfter.getTime() - now.getTime()) / DAY_MS;
  const hosts = subjectAltNames(certificate);
  const missingHosts = RUNNER_TLS_HOSTS.filter((host) => !hosts.includes(host));
  if (missingHosts.length > 0) problems.push(`it does not cover ${missingHosts.join(", ")}`);
  if (daysLeft <= 0) problems.push("it has expired");

  try {
    if (!certificate.checkPrivateKey(createPrivateKey(privateKeyPem ?? ""))) {
      problems.push("the private key does not match the certificate");
    }
  } catch {
    problems.push("the private key is not a PEM private key");
  }

  return {
    problems,
    daysLeft,
    notAfter: notAfter.toISOString(),
    fingerprint: certificate.fingerprint256,
    hosts,
    issuer: certificate.issuer.replaceAll("\n", ", "),
  };
}

export function renewalReason({ certificatePem, privateKeyPem, now = new Date(), force = false }) {
  if (force) return "forced by the workflow input";
  if (!certificatePem?.trim() || !privateKeyPem?.trim())
    return "Infisical /runner has no certificate";
  const inspection = inspectCertificate({ certificatePem, privateKeyPem, now });
  if (inspection.problems.length > 0) return inspection.problems.join("; ");
  if (inspection.daysLeft <= RENEW_WITHIN_DAYS) {
    return `it expires in ${Math.floor(inspection.daysLeft)} days`;
  }
  return null;
}

// kamal-proxy loads the certificate only when the runner deploys. A renewal therefore reaches
// clients with the next runner release, and this decides when the workflow must force one. Until
// the cutover another server answers for the hostname (Vercel's *.opencompany.chat wildcard), so
// only a certificate covering every runner host counts as kamal-proxy's. The probe validates the
// chain, so an expired certificate arrives as `{ expired: true }` with nothing else to compare.
export function servedCertificateAction({ served, stored }) {
  if (served?.expired) {
    return stored.daysLeft > REDEPLOY_WITHIN_DAYS ? "redeploy" : "renewal-failed";
  }
  if (!served || RUNNER_TLS_HOSTS.some((host) => !served.hosts.includes(host))) {
    return "not-served";
  }
  if (served.daysLeft > REDEPLOY_WITHIN_DAYS) return "ok";
  return served.fingerprint === stored.fingerprint ? "renewal-failed" : "redeploy";
}

function subjectAltNames(certificate) {
  return parseSubjectAltNames(certificate.subjectAltName);
}

// Node formats SANs as `DNS:a.example, DNS:b.example` on X509Certificate and TLS peers alike.
export function parseSubjectAltNames(value) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("DNS:"))
    .map((entry) => entry.slice(4));
}
