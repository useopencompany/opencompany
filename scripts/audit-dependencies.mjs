#!/usr/bin/env node

import { spawnSync } from "node:child_process";

// `bun audit` fails the build on any advisory in the dependency tree. A transitive advisory can
// have no safe upgrade, so this wrapper accepts named advisories instead of dropping the whole
// gate. Every exception carries the reason it cannot be fixed, the condition that lifts it, and an
// expiry date that forces a re-review. An exception whose advisory has stopped being reported is
// itself an error, so a fixed dependency cannot leave a silent hole behind.
const acceptedAdvisories = [
  {
    ghsa: "GHSA-vcc3-ghjq-m6fr",
    package: "decode-uri-component",
    // Reached only through expo-router@57 > query-string@7, which pins `decode-uri-component@^0.2.2`.
    // The advisory covers `<=0.4.2`, so 0.5.0 is the sole non-vulnerable release, and 0.5.0 is
    // ESM-only ("type": "module", no CJS entry). query-string@7 is CommonJS and `require()`s it, so
    // an override or a `bun audit fix` silently breaks URL and deep-link parsing in the mobile app
    // at runtime. No CI job boots the iOS app, so that regression would ship green.
    //
    // Accepting it is the smaller risk: the flaw is a denial of service while decoding malformed
    // percent-encoded input, reachable only inside the mobile client's own process when it parses a
    // deep link. There is no server-side or cross-user exposure, and the blast radius is a hang in
    // an app the user can relaunch.
    //
    // Lifts when expo-router depends on query-string >= 9, which requires decode-uri-component 0.5.0.
    expiresOn: "2026-12-31",
  },
  {
    ghsa: "GHSA-qr28-fpjm-wq7f",
    package: "decode-uri-component",
    // Same expo-router@57 > query-string@7 path and ESM-only constraint as GHSA-vcc3-ghjq-m6fr
    // above: 0.5.1 is the first fixed release and query-string@7 cannot `require()` it. The
    // quadratic decode only stalls the mobile client parsing its own deep link. Lifts with the
    // exception above.
    expiresOn: "2026-12-31",
  },
  {
    ghsa: "GHSA-gcqx-w48m-w2h4",
    package: "deepmerge",
    // No patched release exists; 4.3.1 is still the latest. Reached only through
    // @expo/config, which merges repository-owned Expo config at build time. Prototype
    // poisoning needs attacker-controlled input to mergeObject(), and no runtime code path
    // deep-merges user data with it. Remove when deepmerge publishes a fix or Expo drops it.
    expiresOn: "2027-02-28",
  },
  {
    ghsa: "GHSA-mrhx-c7xc-m3w5",
    package: "zod",
    // Fixed only in zod 4.6.6. Our own packages use 4.6.7 and the exact 4.1.11 pin from the
    // Vercel CLI is overridden. The remaining 3.x copies have no patched release: @expo/cli
    // (^3.25.76) and the Vercel CLI builders (@vercel/backends 3.22.4). Both are local or CI
    // build tooling that validate repository config, not request data. Remove when those
    // tools move to zod >= 4.6.6.
    expiresOn: "2027-02-28",
  },
];

const audit = spawnSync("bun", ["audit", "--json"], { encoding: "utf8" });
if (audit.error) {
  console.error(`Dependency audit could not run: ${audit.error.message}`);
  process.exit(1);
}

const stdout = audit.stdout.trim();
let report;
try {
  report = stdout ? JSON.parse(stdout) : {};
} catch {
  console.error("Dependency audit returned output that is not JSON:\n");
  console.error(audit.stdout || audit.stderr);
  process.exit(1);
}

const reported = new Map();
for (const [packageName, advisories] of Object.entries(report)) {
  for (const advisory of advisories ?? []) {
    const ghsa = advisory.url?.split("/").pop() ?? String(advisory.id);
    reported.set(ghsa, { ...advisory, packageName, ghsa });
  }
}

const acceptedByGhsa = new Map(acceptedAdvisories.map((entry) => [entry.ghsa, entry]));
const today = new Date().toISOString().slice(0, 10);
const errors = [];

for (const advisory of reported.values()) {
  const accepted = acceptedByGhsa.get(advisory.ghsa);
  if (!accepted) {
    errors.push(
      `Unaccepted ${advisory.severity} advisory ${advisory.ghsa} in ${advisory.packageName} (${advisory.vulnerable_versions}): ${advisory.title}`,
    );
    continue;
  }
  if (accepted.package !== advisory.packageName) {
    errors.push(
      `Accepted advisory ${advisory.ghsa} is recorded for ${accepted.package} but was reported for ${advisory.packageName}.`,
    );
  }
  if (accepted.expiresOn < today) {
    errors.push(
      `Accepted advisory ${advisory.ghsa} (${advisory.packageName}) expired on ${accepted.expiresOn}; re-review it or extend the exception.`,
    );
  }
}

for (const accepted of acceptedAdvisories) {
  if (!reported.has(accepted.ghsa)) {
    errors.push(
      `Obsolete advisory exception ${accepted.ghsa} (${accepted.package}) is no longer reported; remove it from scripts/audit-dependencies.mjs.`,
    );
  }
}

if (errors.length > 0) {
  console.error("Dependency audit failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const acceptedCount = acceptedAdvisories.length;
console.log(
  `Dependency audit passed (${acceptedCount} accepted ${acceptedCount === 1 ? "advisory" : "advisories"}, no unaccepted advisories).`,
);
