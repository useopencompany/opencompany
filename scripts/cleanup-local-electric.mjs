import { cleanupOutdatedElectricContainers } from "./lib/electric-container-cleanup.mjs";

const isLocal = process.env.CONDUCTOR_IS_LOCAL !== "0" && !process.env.E2B_SANDBOX_ID?.trim();
if (!isLocal) process.exit(0);

const result = cleanupOutdatedElectricContainers();

if (result.status === "unavailable") {
  console.log("  Skipped local Electric cleanup (container runtime is unavailable).");
  process.exit(0);
}

if (result.status === "empty") {
  console.log("  No outdated local Electric containers found.");
  process.exit(0);
}

if (result.status === "failed") {
  console.warn(`  Could not remove outdated local Electric containers: ${result.reason}`);
  process.exit(0);
}

console.log(
  `  Removed ${result.containers.length} outdated local Electric container${result.containers.length === 1 ? "" : "s"}: ${result.containers.join(", ")}`,
);
