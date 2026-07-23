export const RELEASE_SURFACES = ["web", "goat", "marketing", "runner"];

const PACKAGE_SURFACES = new Map([
  ["@opencompany/web", ["web"]],
  ["@opencompany/goat", ["goat"]],
  ["@opencompany/marketing", ["marketing"]],
  ["@opencompany/runner", ["runner"]],
]);

const ALL_SURFACES = RELEASE_SURFACES;
const VERCEL_SURFACES = ["web", "goat", "marketing"];

const FORCE_RULES = [
  { files: [".github/workflows/release-production.yml"], surfaces: ALL_SURFACES },
  {
    files: ["package.json", "turbo.json", "tsconfig.base.json", "bunfig.toml"],
    surfaces: ALL_SURFACES,
  },
  {
    files: [
      "scripts/release-scope.mjs",
      "scripts/lib/release-scope.mjs",
      "scripts/release-smoke.mjs",
      "scripts/lib/release-smoke.mjs",
    ],
    surfaces: ALL_SURFACES,
  },
  { files: ["scripts/release-vercel-deploy.mjs"], surfaces: VERCEL_SURFACES },
  { files: ["vercel.json", "scripts/next-app.mjs"], surfaces: ["web"] },
  { files: ["scripts/next-goat.mjs"], surfaces: ["goat"] },
  { files: ["scripts/load-env.mjs"], surfaces: ["web", "goat"] },
  {
    files: [".dockerignore", "Dockerfile.runner", "render.yaml", "scripts/render-release.mjs"],
    surfaces: ["runner"],
  },
];

export function planReleaseSurfaces({
  affectedPackages = [],
  changedFiles = [],
  deployAll = false,
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

  if (!deployRunner) {
    selected.delete("runner");
  }

  return Object.fromEntries(RELEASE_SURFACES.map((surface) => [surface, selected.has(surface)]));
}
