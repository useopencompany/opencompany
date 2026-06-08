// Neon operations for per-PR preview branches (issue #351), wrapping `neonctl` the same
// way scripts/neon-branch.mjs does for local dev — but headless (always --api-key) and
// returning structured data instead of writing .env.local. Reset-on-synchronize re-forks
// the branch from the sanitized seed so a preview's DB always matches its SHA's migrations.

import { execFileSync } from "node:child_process";
import { toDirectConnectionString } from "./preview-config.mjs";

export function createNeonClient({ apiKey, projectId, parentBranch } = {}) {
  if (!apiKey) throw new Error("NEON_API_KEY is required for preview branches.");
  if (!projectId) throw new Error("NEON_PROJECT_ID is required for preview branches.");

  function neon(args, { json = false } = {}) {
    const full = ["neonctl", ...args, "--project-id", projectId, "--api-key", apiKey];
    if (json) full.push("--output", "json");
    const out = execFileSync("bunx", full, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
    return json ? JSON.parse(out) : out;
  }

  function getBranchByName(name) {
    const branches = neon(["branches", "list"], { json: true });
    const list = Array.isArray(branches) ? branches : (branches.branches ?? []);
    return list.find((b) => b.name === name) ?? null;
  }

  function createBranch(name) {
    const args = ["branches", "create", "--name", name];
    if (parentBranch) args.push("--parent", parentBranch);
    const created = neon(args, { json: true });
    return created.branch ?? created;
  }

  function deleteBranch(name) {
    if (parentBranch && name === parentBranch) {
      throw new Error(`Refusing to delete the seed/parent branch "${parentBranch}".`);
    }
    neon(["branches", "delete", name]);
  }

  // create-from-seed; with reset, drop+recreate so the branch data is deterministic for the SHA.
  function ensureBranch(name, { reset = false } = {}) {
    let branch = getBranchByName(name);
    if (branch && reset) {
      deleteBranch(name);
      branch = null;
    }
    if (!branch) branch = createBranch(name);
    return branch;
  }

  function setExpiration(name, expiresAtIso) {
    if (!expiresAtIso) return;
    neon(["branches", "set-expiration", name, "--expires-at", expiresAtIso]);
  }

  function pooledConnectionString(name, options = {}) {
    // Neon branches forked from prod can carry multiple roles (e.g. neondb_owner +
    // Supabase-style authenticator/anon/authenticated), so connection-string requires an
    // explicit role. Default to the owner; override via NEON_ROLE_NAME / NEON_DATABASE_NAME.
    const databaseName = options.databaseName || process.env.NEON_DATABASE_NAME || "neondb";
    const roleName = options.roleName || process.env.NEON_ROLE_NAME || "neondb_owner";
    return neon(["connection-string", name, "--pooled", "--database-name", databaseName, "--role-name", roleName]);
  }

  return {
    neon,
    getBranchByName,
    ensureBranch,
    deleteBranch,
    setExpiration,
    pooledConnectionString,
    /** Returns { branch, branchId, pooledUrl, directUrl } for a ready branch. */
    resolveConnection(name, opts) {
      const branch = getBranchByName(name);
      if (!branch) throw new Error(`Neon branch ${name} not found.`);
      const pooledUrl = pooledConnectionString(name, opts);
      return {
        branch,
        branchId: branch.id,
        pooledUrl,
        directUrl: toDirectConnectionString(pooledUrl),
      };
    },
  };
}
