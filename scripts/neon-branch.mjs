import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const action = process.argv[2];
const projectId = process.env.NEON_PROJECT_ID;
const parentBranch = process.env.NEON_PARENT_BRANCH;
const databaseName = process.env.NEON_DATABASE_NAME;
const roleName = process.env.NEON_ROLE_NAME;
const apiKey = process.env.NEON_API_KEY;

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

  // neonctl resolves the project from (in order): --project-id flag,
  // `neon set-context` config, or single-project auto-detect.
  if (projectId) {
    baseArgs.push("--project-id", projectId);
  }

  // Browser OAuth via `neon auth` is preferred locally. NEON_API_KEY is
  // only needed in headless environments like CI/Vercel.
  if (apiKey) {
    baseArgs.push("--api-key", apiKey);
  }

  try {
    return execFileSync("npx", baseArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  } catch (error) {
    if (!projectId && !apiKey) {
      console.error(
        "\nHint: run `npx neonctl auth` to log in, then either set NEON_PROJECT_ID\n" +
          "or run `npx neonctl set-context --project-id <id>` to pin the project.\n",
      );
    }
    throw error;
  }
}

function connectionString(branchName) {
  const args = ["connection-string", branchName, "--pooled"];

  if (databaseName) {
    args.push("--database-name", databaseName);
  }

  if (roleName) {
    args.push("--role-name", roleName);
  }

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
