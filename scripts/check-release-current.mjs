#!/usr/bin/env node

import { appendFileSync } from "node:fs";

import { githubRequest } from "./lib/release-deployments.mjs";

const repository = requiredEnv("GITHUB_REPOSITORY");
const releaseSha = requiredEnv("RELEASE_SHA");
const token = requiredEnv("GITHUB_TOKEN");
const commit = await githubRequest(`/repos/${repository}/commits/main`, { token });
const shouldRelease = commit.sha === releaseSha;

writeOutput("should_release", String(shouldRelease));
if (shouldRelease) {
  console.log(`Release ${releaseSha.slice(0, 7)} is still current on main.`);
} else {
  console.log(
    `Release ${releaseSha.slice(0, 7)} was superseded by ${commit.sha.slice(0, 7)}; production changes will stop.`,
  );
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
