import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export const ERROR_REPORTING_DSN_ENV_KEYS = [
  "BETTER_STACK_ERRORS_DSN",
  "NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN",
];

export function errorReportingEnvRemovalPlan(paths) {
  return paths.flatMap((path) => {
    if (!existsSync(path)) return [];
    const source = readFileSync(path, "utf8");
    return ERROR_REPORTING_DSN_ENV_KEYS.filter((key) =>
      source.split("\n").some((line) => line.startsWith(`${key}=`)),
    ).map((key) => ({ path, key }));
  });
}

export function removeGeneratedErrorReportingEnv(paths) {
  const removals = errorReportingEnvRemovalPlan(paths);
  if (removals.length === 0) return [];

  for (const path of new Set(removals.map((entry) => entry.path))) {
    const keys = new Set(removals.filter((entry) => entry.path === path).map((entry) => entry.key));
    const source = readFileSync(path, "utf8");
    const next = source
      .split("\n")
      .filter((line) => {
        const key = line.match(/^([A-Z][A-Z0-9_]*)=/u)?.[1];
        return !key || !keys.has(key);
      })
      .join("\n");
    writeFileSync(path, next);
    chmodSync(path, 0o600);
  }

  return removals;
}

export function intentionalErrorReportingEnv({ inheritedEnv, personalEnvPath }) {
  const personalEnv = parseEnv(personalEnvPath);
  return Object.fromEntries(
    ERROR_REPORTING_DSN_ENV_KEYS.flatMap((key) => {
      const value = inheritedEnv[key] ?? personalEnv[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

export function restoreIntentionalErrorReportingEnv(processEnv, intentionalEnv) {
  for (const key of ERROR_REPORTING_DSN_ENV_KEYS) {
    if (intentionalEnv[key] === undefined) {
      delete processEnv[key];
    } else {
      processEnv[key] = intentionalEnv[key];
    }
  }
}

function parseEnv(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (!match) continue;
    const value = match[2];
    values[match[1]] = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  }
  return values;
}
