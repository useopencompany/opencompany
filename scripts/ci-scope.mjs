#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { isFullSha, resolveCiScope } from "./lib/ci-scope.mjs";

const options = parseArgs(process.argv.slice(2));
const baseExists = commitExists(options.base);
const headExists = commitExists(options.head);
const baseIsAncestor =
  baseExists &&
  headExists &&
  spawnSync("git", ["merge-base", "--is-ancestor", options.base, options.head], {
    stdio: "ignore",
  }).status === 0;
const changedFiles = baseIsAncestor ? readChangedFiles(options.base, options.head) : [];
const result = resolveCiScope({
  requestedScope: options.requestedScope,
  baseSha: options.base,
  headSha: options.head,
  baseExists,
  headExists,
  baseIsAncestor,
  changedFiles,
});

console.log(`CI scope: ${result.scope} (${result.reason}).`);
writeOutput("scope", result.scope);

function parseArgs(args) {
  const parsed = { base: "", head: "", requestedScope: "affected" };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--base" || flag === "--head" || flag === "--requested-scope") {
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      if (flag === "--base") parsed.base = value;
      if (flag === "--head") parsed.head = value;
      if (flag === "--requested-scope") parsed.requestedScope = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  return parsed;
}

function commitExists(sha) {
  if (!isFullSha(sha)) return false;
  return spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" }).status === 0;
}

function readChangedFiles(baseSha, headSha) {
  return execFileSync("git", ["diff", "--name-only", "--diff-filter=ACDMRTUXB", baseSha, headSha], {
    encoding: "utf8",
  })
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
