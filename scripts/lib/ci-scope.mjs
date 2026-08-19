export const FULL_RUN_FILES = new Set([
  ".nvmrc",
  "biome.json",
  "bun.lock",
  "bunfig.toml",
  "package.json",
  "tsconfig.base.json",
  "turbo.json",
]);

export function requiresFullCi(changedFiles) {
  return changedFiles.some(
    (file) =>
      FULL_RUN_FILES.has(file) ||
      file.startsWith(".github/workflows/") ||
      file.startsWith(".github/actions/") ||
      file === "scripts/ci-scope.mjs" ||
      file === "scripts/lib/ci-scope.mjs" ||
      file === "scripts/lib/ci-scope.test.mjs" ||
      /^apps\/[^/]+\/package\.json$/u.test(file) ||
      /^packages\/[^/]+\/package\.json$/u.test(file),
  );
}

export function resolveCiScope({
  requestedScope,
  baseSha,
  headSha,
  baseExists,
  headExists,
  baseIsAncestor,
  changedFiles = [],
}) {
  if (requestedScope !== "affected" && requestedScope !== "full") {
    return { scope: "full", reason: `invalid requested scope: ${requestedScope || "<empty>"}` };
  }
  if (requestedScope === "full") {
    return { scope: "full", reason: "a full run was requested" };
  }
  if (!isFullSha(baseSha) || !isFullSha(headSha)) {
    return { scope: "full", reason: "the comparison did not contain full Git SHAs" };
  }
  if (!baseExists || !headExists) {
    return { scope: "full", reason: "a comparison commit was unavailable" };
  }
  if (baseSha === headSha) {
    return { scope: "full", reason: "the comparison range was empty" };
  }
  if (!baseIsAncestor) {
    return { scope: "full", reason: "the base commit was not an ancestor of the head" };
  }
  if (requiresFullCi(changedFiles)) {
    return { scope: "full", reason: "CI or workspace graph configuration changed" };
  }
  return { scope: "affected", reason: "the Git comparison is safe for Turbo --affected" };
}

export function isFullSha(value) {
  return /^[a-f0-9]{40}$/iu.test(value ?? "");
}
