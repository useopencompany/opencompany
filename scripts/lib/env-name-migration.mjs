import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const SPECIAL_ENV_RENAMES = new Map([
  ["EXPECTED_GOAT_RELEASE", "EXPECTED_WEB_RELEASE"],
  ["SMOKE_GOAT", "SMOKE_WEB"],
  ["SMOKE_GOAT_ATTEMPTS", "SMOKE_WEB_ATTEMPTS"],
  ["SMOKE_GOAT_VERCEL_DEPLOYMENT", "SMOKE_WEB_VERCEL_DEPLOYMENT"],
  ["OPENCOMPANY_GOAT_HTTPS_DISABLED", "OPENCOMPANY_HTTPS_DISABLED"],
]);

export function migratedEnvironmentName(name) {
  const special = SPECIAL_ENV_RENAMES.get(name);
  if (special) return special;
  if (!/(^|_)GOAT(?=_|$)/u.test(name)) return null;
  return name.replace(/(^|_)GOAT(?=_|$)/u, "$1OPENCOMPANY");
}

export function environmentFileMigrationPlan(path) {
  if (!existsSync(path)) return [];

  const assignments = readAssignments(path);
  const moves = [];
  const conflicts = [];

  for (const [oldName, oldValue] of assignments) {
    const newName = migratedEnvironmentName(oldName);
    if (!newName) continue;
    moves.push({ oldName, newName });
    if (assignments.has(newName) && assignments.get(newName) !== oldValue) {
      conflicts.push(`${oldName} → ${newName}`);
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `${path} contains conflicting old and new environment variables: ${conflicts.join(", ")}. ` +
        "Keep the intended value under the new name and remove the old entry, then run setup again.",
    );
  }

  return moves;
}

export function migrateEnvironmentFile(path) {
  const moves = environmentFileMigrationPlan(path);
  if (moves.length === 0) return [];

  const source = readFileSync(path, "utf8");
  const lines = source.split("\n");
  const originalNames = new Set(
    lines.flatMap((line) => line.match(/^([A-Z][A-Z0-9_]*)=/u)?.[1] ?? []),
  );
  const lastAssignmentIndex = new Map();
  for (const [index, line] of lines.entries()) {
    const name = line.match(/^([A-Z][A-Z0-9_]*)=/u)?.[1];
    if (name) lastAssignmentIndex.set(name, index);
  }

  const next = lines.flatMap((line, index) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)(=.*)$/u);
    if (!match) return [line];
    const oldName = match[1];
    const newName = migratedEnvironmentName(oldName);
    if (!newName) return [line];
    if (originalNames.has(newName)) return [];
    if (lastAssignmentIndex.get(oldName) !== index) return [];
    return [`${newName}${match[2]}`];
  });

  writeFileSync(path, next.join("\n"));
  chmodSync(path, 0o600);
  return moves;
}

function readAssignments(path) {
  const assignments = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (!match) continue;
    assignments.set(match[1], normalizedValue(match[2]));
  }
  return assignments;
}

function normalizedValue(raw) {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}
