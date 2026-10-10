#!/usr/bin/env node

import { spawnSync } from "node:child_process";

// `bun audit` fails the build on any advisory in the dependency tree. A transitive advisory can
// have no safe upgrade, so this wrapper accepts named advisories instead of dropping the whole
// gate. Every exception carries the reason it cannot be fixed, the condition that lifts it, and an
// expiry date that forces a re-review. An exception whose advisory has stopped being reported is
// itself an error, so a fixed dependency cannot leave a silent hole behind.
const acceptedAdvisories = [
  {
    ghsa: "GHSA-hp3w-g68c-fv3c",
    package: "sprintf-js",
    // No patched release exists; 1.1.3 is still the latest. Reached through
    // gray-matter > js-yaml > argparse in marketing builds and roarr > global-agent
    // in Electron packaging. The RangeError requires an attacker-controlled format
    // string; these callers use fixed error and log formats. Remove this exception
    // when a compatible patched release exists, and re-review any new runtime use.
    expiresOn: "2026-10-31",
  },
  {
    ghsa: "GHSA-vfj7-8cjw-p6xm",
    package: "braces",
    // No patched release exists; 3.0.3 is still the latest. micromatch brings it into
    // Metro and fast-glob tooling. The stack-exhaustion attack requires a deeply
    // nested brace pattern; these tools currently consume repository-defined globs.
    // Remove this exception when a patched compatible release is available, and
    // re-review it before exposing these tools to untrusted glob patterns.
    expiresOn: "2026-10-31",
  },
  {
    ghsa: "GHSA-ch52-4w7c-c8xp",
    package: "http-cache-semantics",
    // No patched release exists; 4.2.0 is still the latest. This copy is reached
    // through cacheable-request > got > @electron/get in desktop packaging.
    // The max-stale flaw affects shared HTTP caches; our use is an artifact
    // downloader, not a cache shared by application users. Remove this exception
    // when a patched compatible release is available, and re-review any new use.
    expiresOn: "2026-10-31",
  },
  {
    ghsa: "GHSA-86w9-cpqp-85rv",
    package: "node-forge",
    // No patched release exists. patches/node-forge@1.4.0.patch applies the nested
    // DigestAlgorithm element-count fix from digitalbazaar/forge#1152, commit
    // ceba34402e329f0365134f23fe19898756527d65. The package is used by Expo tooling.
    // scripts/lib/node-forge.test.mjs verifies rejection and valid signatures in CI.
    // Remove the patch and exception when node-forge publishes the fix.
    expiresOn: "2026-10-31",
  },
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
