import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "./args";
import { HELP, validateCommandArgs } from "./index";
import { execaNode } from "./test-support";

const require = createRequire(import.meta.url);
const cliPath = require.resolve("./index.ts");
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "goat-brain-cli-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("goat-brain cli", () => {
  it("validates unknown options", () => {
    expect(validateCommandArgs("create", parseArgs(["--nope"]))).toBe('Unknown option "--nope".');
    expect(HELP).toContain("goat-brain <command>");
  });

  it("creates, reads, rewrites, links, and doctors docs", async () => {
    await expect(
      run([
        "create",
        "--root",
        root,
        "--folder",
        "ideas",
        "--id",
        "launch-plan",
        "--title",
        "Launch plan",
      ]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('Created "launch-plan"'),
    });
    await expect(
      run([
        "append-timeline",
        "--root",
        root,
        "launch-plan",
        "--body",
        "Discussed launch sequencing.",
      ]),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      run([
        "rewrite",
        "--root",
        root,
        "launch-plan",
        "--truth",
        "Launch should start with founder-led beta.",
      ]),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      run(["create", "--root", root, "--folder", "people", "--id", "jane", "--title", "Jane"]),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      run(["link", "--root", root, "launch-plan", "--to", "jane", "--as", "owner"]),
    ).resolves.toMatchObject({ exitCode: 0 });

    const get = await run(["get", "--root", root, "launch-plan", "--section", "truth"]);
    expect(get.stdout).toContain("founder-led beta");

    const query = await run(["query", "--root", root, "founder beta", "--lexical-only"]);
    expect(query.stdout).toContain("launch-plan");

    await expect(run(["doctor", "--root", root])).resolves.toMatchObject({ exitCode: 0 });
  });
});

async function run(args: string[]) {
  return execaNode(cliPath, args);
}
