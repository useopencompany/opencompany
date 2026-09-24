// Verifies electron-builder output before it can reach users.
//
//   node scripts/verify-package.mjs            structure, Info.plist, and update feed
//   node scripts/verify-package.mjs --signed   also Developer ID signature and notarization (macOS)
//
// Signed mode reads APPLE_TEAM_ID so an app signed by another team, which
// Squirrel.Mac would refuse as an update, fails here instead.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";
import plist from "plist";
import YAML from "yaml";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(desktopDir, "release");
const signed = process.argv.includes("--signed");
const { version } = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const builderConfig = YAML.parse(
  readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8"),
);

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

const EXPECTED_ASAR_ENTRIES = new Set([
  "/package.json",
  "/dist",
  "/dist/main.js",
  "/dist/preload.js",
  "/assets",
  "/assets/icon-source.svg",
  "/assets/icon.png",
  "/assets/offline.html",
]);

function verifyApp(appPath) {
  const label = path.relative(releaseDir, appPath);
  const info = plist.parse(readFileSync(path.join(appPath, "Contents/Info.plist"), "utf8"));
  check(
    info.CFBundleIdentifier === builderConfig.appId,
    `${label}: bundle id ${info.CFBundleIdentifier}`,
  );
  check(
    info.CFBundleShortVersionString === version,
    `${label}: version ${info.CFBundleShortVersionString}`,
  );
  const schemes = (info.CFBundleURLTypes ?? []).flatMap((type) => type.CFBundleURLSchemes ?? []);
  check(
    schemes.includes("opencompany"),
    `${label}: opencompany:// sign-in handoff is not registered`,
  );
  check(
    Boolean(info.NSMicrophoneUsageDescription),
    `${label}: missing microphone usage description`,
  );

  const asarPath = path.join(appPath, "Contents/Resources/app.asar");
  const unexpected = listPackage(asarPath).filter((entry) => !EXPECTED_ASAR_ENTRIES.has(entry));
  check(
    unexpected.length === 0,
    `${label}: unexpected app.asar entries: ${unexpected.slice(0, 5).join(", ")}`,
  );

  const updateConfig = YAML.parse(
    readFileSync(path.join(appPath, "Contents/Resources/app-update.yml"), "utf8"),
  );
  const { provider, owner, repo } = builderConfig.publish;
  check(
    updateConfig.provider === provider &&
      updateConfig.owner === owner &&
      updateConfig.repo === repo,
    `${label}: app-update.yml does not point at ${owner}/${repo} releases`,
  );

  if (!signed) return;
  const run = (command, args) =>
    execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const runCombined = (command, args) =>
    execFileSync("/bin/sh", ["-c", '"$0" "$@" 2>&1', command, ...args], { encoding: "utf8" });

  run("codesign", ["--verify", "--deep", "--strict", appPath]);
  const signature = runCombined("codesign", ["-dvv", appPath]);
  const teamId = process.env.APPLE_TEAM_ID;
  check(Boolean(teamId), "APPLE_TEAM_ID is required to verify the signing team");
  check(signature.includes(`TeamIdentifier=${teamId}`), `${label}: not signed by team ${teamId}`);
  check(/flags=0x[0-9a-f]+\(runtime\)/.test(signature), `${label}: hardened runtime is off`);
  check(
    runCombined("spctl", ["--assess", "--type", "execute", "-vv", appPath]).includes(
      "source=Notarized Developer ID",
    ),
    `${label}: Gatekeeper does not see a notarized Developer ID app`,
  );
  run("xcrun", ["stapler", "validate", appPath]);
}

const appPaths = readdirSync(releaseDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
  .map((entry) => path.join(releaseDir, entry.name, `${builderConfig.productName}.app`))
  .filter((appPath) => existsSync(appPath));
check(appPaths.length > 0, "no packaged .app found in release/");
for (const appPath of appPaths) {
  try {
    verifyApp(appPath);
  } catch (error) {
    failures.push(`${path.relative(releaseDir, appPath)}: ${error.message.trim()}`);
  }
}

// The update feed must describe exactly the zips we built, byte for byte.
const feedPath = path.join(releaseDir, "latest-mac.yml");
if (existsSync(feedPath)) {
  const feed = YAML.parse(readFileSync(feedPath, "utf8"));
  check(feed.version === version, `latest-mac.yml version ${feed.version}`);
  const zips = feed.files.filter((file) => file.url.endsWith(".zip"));
  check(zips.length === appPaths.length, `latest-mac.yml lists ${zips.length} zips`);
  for (const file of zips) {
    const zipPath = path.join(releaseDir, file.url);
    if (!existsSync(zipPath)) {
      failures.push(`latest-mac.yml references missing ${file.url}`);
      continue;
    }
    const sha512 = createHash("sha512").update(readFileSync(zipPath)).digest("base64");
    check(sha512 === file.sha512, `${file.url}: sha512 does not match latest-mac.yml`);
    check(existsSync(`${zipPath}.blockmap`), `${file.url}: missing blockmap for delta updates`);
  }
} else {
  failures.push("latest-mac.yml was not generated");
}

if (failures.length > 0) {
  console.error(`Desktop package verification failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `Verified ${appPaths.length} app bundle(s) for ${version}${signed ? " (signed and notarized)" : ""}.`,
);
