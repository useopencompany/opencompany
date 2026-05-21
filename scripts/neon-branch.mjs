import "./load-env.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function realEnv(name) {
  const value = process.env[name];
  if (!value) return undefined;
  // Treat .env.example placeholders ("...", "sk_test_...", etc.) as unset.
  if (value === "..." || value.includes("...") || value.startsWith("replace-")) {
    return undefined;
  }
  return value;
}

const action = process.argv[2];
const projectId = realEnv("NEON_PROJECT_ID");
const parentBranch = realEnv("NEON_PARENT_BRANCH");
const databaseName = realEnv("NEON_DATABASE_NAME");
const roleName = realEnv("NEON_ROLE_NAME");
const apiKey = realEnv("NEON_API_KEY");
const DEFAULT_DATABASE_NAME = "neondb";
const DEFAULT_ROLE_NAME = "neondb_owner";

if (!["create", "delete"].includes(action)) {
  throw new Error("Usage: node scripts/neon-branch.mjs <create|delete>");
}

function currentGitBranch() {
  const branch = execFileSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
  }).trim();

  if (!branch) {
    throw new Error("Could not determine the current Git branch.");
  }

  return branch;
}

function neonBranchName() {
  return currentGitBranch()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function neon(args) {
  const baseArgs = ["neonctl", ...args];

  // Always pass the project id when available so generated worktrees do not
  // depend on local neonctl context files.
  if (projectId) {
    baseArgs.push("--project-id", projectId);
  }

  // Browser OAuth via `neon auth` is preferred locally. NEON_API_KEY is
  // only needed in headless environments like CI/Vercel.
  if (apiKey) {
    baseArgs.push("--api-key", apiKey);
  }

  try {
    return execFileSync("bunx", baseArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  } catch (error) {
    if (!projectId && !apiKey) {
      console.error(
        "\nHint: run `bun run env:pull` to copy NEON_PROJECT_ID from Vercel Development,\n" +
          "or set NEON_PROJECT_ID in .env.local manually.\n",
      );
    } else if (args[0] === "connection-string" && !roleName) {
      console.error(
        "\nHint: this Neon project has multiple roles. The setup script normally\n" +
          "auto-selects `neondb_owner`; set NEON_ROLE_NAME only for nonstandard projects.\n",
      );
    }
    throw error;
  }
}

function resourceName(items, preferredName, label, envName) {
  const names = items.map((item) => item.name).filter(Boolean);
  if (names.includes(preferredName)) return preferredName;
  if (names.length === 1) return names[0];
  throw new Error(
    `Multiple Neon ${label}s found (${names.join(", ")}). Set ${envName} in .env.local to choose one.`,
  );
}

function connectionDatabaseName(branchName) {
  if (databaseName) return databaseName;
  const databases = JSON.parse(neon(["databases", "list", "--branch", branchName, "--output", "json"]));
  return resourceName(databases, DEFAULT_DATABASE_NAME, "databases", "NEON_DATABASE_NAME");
}

function connectionRoleName(branchName) {
  if (roleName) return roleName;
  const roles = JSON.parse(neon(["roles", "list", "--branch", branchName, "--output", "json"]));
  return resourceName(roles, DEFAULT_ROLE_NAME, "roles", "NEON_ROLE_NAME");
}

function connectionString(branchName) {
  const args = ["connection-string", branchName, "--pooled"];

  args.push("--database-name", connectionDatabaseName(branchName));
  args.push("--role-name", connectionRoleName(branchName));

  return neon(args);
}

function upsertEnvFile(values) {
  const envPath = ".env.local";
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : [];
  const next = new Map();

  for (const line of existing) {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (match) {
      next.set(match[1], line);
    } else if (line.trim()) {
      next.set(`__line_${next.size}`, line);
    }
  }

  for (const [key, value] of Object.entries(values)) {
    next.set(key, `${key}=${JSON.stringify(value)}`);
  }

  writeFileSync(envPath, `${Array.from(next.values()).join("\n")}\n`);
}

const branchName = neonBranchName();

if (action === "create") {
  const branches = JSON.parse(neon(["branches", "list", "--output", "json"]));
  const exists = branches.some((branch) => branch.name === branchName);

  if (!exists) {
    const createArgs = ["branches", "create", "--name", branchName, "--output", "json"];
    if (parentBranch) {
      createArgs.push("--parent", parentBranch);
    }
    neon(createArgs);
  }

  const url = connectionString(branchName);
  upsertEnvFile({
    DATABASE_URL: url,
    NEON_BRANCH: branchName,
  });
  console.log(`Neon branch ready: ${branchName}`);
  console.log("Updated .env.local with DATABASE_URL and NEON_BRANCH.");
}

if (action === "delete") {
  if (parentBranch && branchName === parentBranch) {
    throw new Error(`Refusing to delete parent branch "${parentBranch}".`);
  }

  neon(["branches", "delete", branchName]);
  console.log(`Deleted Neon branch: ${branchName}`);
}
