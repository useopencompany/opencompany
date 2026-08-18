export const RELEASE_SURFACES = ["web", "marketing", "api", "runner"];
export const RELEASE_STATE_SURFACES = ["database", ...RELEASE_SURFACES];

const PACKAGE_SURFACES = new Map([
  ["@opencompany/web", ["web"]],
  ["@opencompany/marketing", ["marketing"]],
  ["@opencompany/api", ["api"]],
  ["@opencompany/runner", ["runner"]],
  ["@opencompany/db", ["web", "api", "runner"]],
  ["@opencompany/chat-presentation", ["api", "runner"]],
]);

const ALL_SURFACES = RELEASE_SURFACES;
const VERCEL_SURFACES = ["web", "marketing"];

const FORCE_RULES = [
  { files: [".github/workflows/release-production.yml"], surfaces: ALL_SURFACES },
  {
    files: [
      ".nvmrc",
      "bun.lock",
      "package.json",
      "turbo.json",
      "tsconfig.base.json",
      "bunfig.toml",
    ],
    surfaces: ALL_SURFACES,
  },
  {
    files: [
      "scripts/release-plan.mjs",
      "scripts/release-deployment.mjs",
      "scripts/lib/release-deployments.mjs",
      "scripts/check-release-current.mjs",
      "scripts/check-release-results.mjs",
      "scripts/release-render-services.mjs",
      "scripts/lib/release-orchestration.mjs",
      "scripts/release-scope.mjs",
      "scripts/lib/release-scope.mjs",
      "scripts/release-smoke.mjs",
      "scripts/lib/release-smoke.mjs",
      "scripts/release-preflight.mjs",
    ],
    surfaces: ALL_SURFACES,
  },
  {
    files: [
      "scripts/release-vercel-deploy.mjs",
      "scripts/release-vercel-prepare.mjs",
      "scripts/lib/release-vercel.mjs",
    ],
    surfaces: VERCEL_SURFACES,
  },
  { files: ["scripts/next-web.mjs"], surfaces: ["web"] },
  { files: ["scripts/load-env.mjs"], surfaces: ["web"] },
  { files: ["Dockerfile.api"], surfaces: ["api"] },
  { files: ["Dockerfile.runner"], surfaces: ["runner"] },
  {
    files: [
      ".dockerignore",
      "render.yaml",
      "scripts/render-release.mjs",
      "scripts/lib/render-release.mjs",
    ],
    surfaces: ["api", "runner"],
  },
];

export function planReleaseSurfaces({
  affectedPackages = [],
  changedFiles = [],
  deployAll = false,
  deployApi = true,
  deployRunner = true,
} = {}) {
  const selected = new Set(deployAll ? RELEASE_SURFACES : []);

  if (!deployAll) {
    for (const packageName of affectedPackages) {
      for (const surface of PACKAGE_SURFACES.get(packageName) ?? []) {
        selected.add(surface);
      }
    }

    for (const rule of FORCE_RULES) {
      if (changedFiles.some((file) => rule.files.includes(file))) {
        for (const surface of rule.surfaces) {
          selected.add(surface);
        }
      }
    }
  }

  if (!deployApi) {
    selected.delete("api");
  }

  if (!deployRunner) {
    selected.delete("runner");
  }

  return Object.fromEntries(RELEASE_SURFACES.map((surface) => [surface, selected.has(surface)]));
}

export function databaseChanged({ affectedPackages = [], changedFiles = [] } = {}) {
  return (
    affectedPackages.includes("@opencompany/db") ||
    changedFiles.some(
      (file) =>
        file.startsWith("drizzle/") ||
        file.startsWith("packages/db/") ||
        file === "scripts/check-schema-migration.mjs" ||
        file === "scripts/check-migration-journal.mjs",
    )
  );
}

export function finalizeReleasePlan({
  requestedSurfaces,
  databaseHasChanges = false,
  deployAll = false,
  deployApi = true,
  deployRunner = true,
}) {
  const plan = { ...requestedSurfaces };
  if (!deployApi) plan.api = false;
  if (!deployRunner) plan.runner = false;

  return {
    database: deployAll || databaseHasChanges,
    ...plan,
  };
}
