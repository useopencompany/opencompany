#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";

import { unsignedCommits } from "./lib/dco.mjs";

const baseSha = requiredEnv("BASE_SHA");
const headSha = requiredEnv("HEAD_SHA");

if (!/^[a-f0-9]{40}$/iu.test(baseSha) || !/^[a-f0-9]{40}$/iu.test(headSha)) {
  throw new Error("BASE_SHA and HEAD_SHA must be full Git commit SHAs.");
}
if (
  spawnSync("git", ["merge-base", baseSha, headSha], {
    stdio: "ignore",
  }).status !== 0
) {
  throw new Error("The DCO comparison commits do not share history.");
}

const shas = execFileSync(
  "git",
  ["rev-list", "--reverse", "--right-only", "--no-merges", `${baseSha}...${headSha}`],
  {
    encoding: "utf8",
  },
)
  .split("\n")
  .map((sha) => sha.trim())
  .filter(Boolean);
const commits = shas.map((sha) => ({
  sha,
  message: execFileSync("git", ["show", "-s", "--format=%B", sha], { encoding: "utf8" }),
}));
const missing = unsignedCommits(commits);

if (missing.length > 0) {
  for (const commit of missing) {
    console.error(
      `::error::Commit ${commit.sha.slice(0, 12)} is missing a valid Signed-off-by trailer.`,
    );
  }
  console.error(
    "Add signoffs with `git commit --amend --signoff` or an interactive rebase, then push.",
  );
  process.exit(1);
}

console.log(`DCO check passed for ${commits.length} non-merge commit(s).`);

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
