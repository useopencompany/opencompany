#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const documentationFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { cwd: repositoryRoot, encoding: "utf8" },
)
  .split("\n")
  .filter(
    (file) =>
      /(?:^|\/)README\.md$|\.mdx?$/u.test(file) &&
      !file.startsWith(".agents/") &&
      !file.startsWith(".claude/"),
  );

const failures = [];

for (const relativeFile of documentationFiles) {
  const absoluteFile = path.join(repositoryRoot, relativeFile);
  let source;
  try {
    source = await readFile(absoluteFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }

  const links = extractLinks(source);
  for (const { target, line } of links) {
    if (!isLocalTarget(target)) continue;

    const resolved = resolveTarget(absoluteFile, target);
    if (!(await targetExists(resolved))) {
      failures.push(`${relativeFile}:${line}: missing local target ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Broken documentation links:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation links valid across ${documentationFiles.length} Markdown files.`);
}

function extractLinks(source) {
  const links = [];
  const patterns = [/!?\[[^\]]*\]\((?<target>[^)]+)\)/gu, /^\s*\[[^\]]+\]:\s*(?<target>\S+)/gmu];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      let target = match.groups?.target?.trim() ?? "";
      if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
      if (!target.startsWith("<")) target = target.split(/\s+["']/u, 1)[0] ?? target;
      links.push({ target, line: source.slice(0, match.index).split("\n").length });
    }
  }

  return links;
}

function isLocalTarget(target) {
  if (!target || target.startsWith("#") || target.startsWith("/")) return false;
  if (/^(?:…|\.\.\.)$/u.test(target)) return false;
  if (/^(?:https?:|mailto:|tel:|data:|app:|skill:|\/\/)/iu.test(target)) return false;
  return !/[{}]/u.test(target);
}

function resolveTarget(sourceFile, target) {
  const pathname = target.split(/[?#]/u, 1)[0] ?? "";
  return path.resolve(path.dirname(sourceFile), decodeURIComponent(pathname));
}

async function targetExists(target) {
  const candidates = [target, `${target}.md`, `${target}.mdx`, path.join(target, "README.md")];
  for (const candidate of candidates) {
    try {
      const details = await stat(candidate);
      if (details.isFile() || details.isDirectory()) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
