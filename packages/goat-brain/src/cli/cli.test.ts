import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGoatBrainCliSource } from "../generated/cli-bundle";
import { DEFAULT_GOAT_BRAIN_FOLDERS } from "../schema";
import { parseArgs } from "./args";
import { HELP, ingestCommandExitCode, validateCommandArgs } from "./index";
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
    expect(validateCommandArgs("ingest", parseArgs(["--nope"]))).toBe('Unknown option "--nope".');
    expect(validateCommandArgs("create", parseArgs(["--nope"]))).toBe('Unknown option "--nope".');
    expect(HELP).toContain("goat-brain <command>");
    expect(HELP).toContain("doctor");
  });

  it("lists the system default folders", async () => {
    const listed = await run(["folder", "--root", root, "list"]);

    expect(listed).toMatchObject({ exitCode: 0 });
    expect(listed.stdout.trim().split("\n").toSorted()).toEqual(
      [...DEFAULT_GOAT_BRAIN_FOLDERS].toSorted(),
    );
  });

  it("lists brain docs without retrieval", async () => {
    await expect(
      run([
        "create",
        "--root",
        root,
        "--folder",
        "projects",
        "--id",
        "launch-plan",
        "--title",
        "Launch plan",
      ]),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      run(["create", "--root", root, "--folder", "people", "--id", "jane", "--title", "Jane"]),
    ).resolves.toMatchObject({ exitCode: 0 });

    const listed = await run(["list", "--root", root, "--folder", "projects", "--json"]);
    const parsed = JSON.parse(listed.stdout) as {
      ok: boolean;
      count: number;
      docs: Array<{ id: string; folder: string; title: string; path: string }>;
    };

    expect(parsed).toMatchObject({ ok: true, count: 1 });
    expect(parsed.docs).toEqual([
      {
        id: "launch-plan",
        folder: "projects",
        title: "Launch plan",
        path: "projects/launch-plan.md",
        type: "project",
        updatedAt: expect.any(String),
      },
    ]);

    const text = await run(["list", "--root", root, "--limit", "1"]);
    expect(text.stdout.trim().split("\n")).toHaveLength(1);
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

  it("adds and reads sourced timeline entries through gbrain-style commands", async () => {
    await expect(
      run([
        "create",
        "--root",
        root,
        "--folder",
        "ideas",
        "--id",
        "timeline-note",
        "--title",
        "Timeline note",
      ]),
    ).resolves.toMatchObject({ exitCode: 0 });

    await expect(
      run([
        "timeline-add",
        "--root",
        root,
        "timeline-note",
        "2026-01-02",
        "Met Ada about launch sequencing.",
        "--detail",
        "Ada recommended starting with founder-led beta.",
        "--source-ref",
        "goat-chat:message_1",
        "--source-title",
        "Launch chat",
      ]),
    ).resolves.toMatchObject({ exitCode: 0 });

    const timeline = await run(["timeline", "--root", root, "timeline-note", "--json"]);
    const parsed = JSON.parse(timeline.stdout) as {
      timeline: Array<{ at: string; body: string }>;
    };
    expect(parsed.timeline).toEqual([
      expect.objectContaining({
        at: "2026-01-02T00:00:00.000Z",
        body: expect.stringContaining("Met Ada about launch sequencing."),
      }),
    ]);
    expect(parsed.timeline[0]?.body).toContain("Source: Launch chat (goat-chat:message_1)");

    const getTimeline = await run([
      "get",
      "--root",
      root,
      "timeline-note",
      "--section",
      "timeline",
    ]);
    expect(getTimeline.stdout).toContain("Met Ada about launch sequencing.");
    expect(getTimeline.stdout).toContain("Source: Launch chat (goat-chat:message_1)");
  });

  it("does not fail ingest for pre-existing health errors outside applied docs", () => {
    expect(
      ingestCommandExitCode({
        applied: [{ id: "new-person" }],
        health: {
          findings: [
            {
              severity: "error",
              id: "old-research",
            },
          ],
        },
      }),
    ).toBe(0);
    expect(
      ingestCommandExitCode({
        applied: [{ id: "new-person" }],
        health: {
          findings: [
            {
              severity: "error",
              id: "new-person",
            },
          ],
        },
      }),
    ).toBe(1);
  });

  it("runs the generated bundle under node from a temp brain root", async () => {
    const cliPath = path.join(root, "goat-brain.mjs");
    await writeFile(cliPath, getGoatBrainCliSource(), "utf8");

    const created = await spawnNode(cliPath, [
      "create",
      "--folder",
      "inbox",
      "--title",
      "Bundle entry",
      "--truth",
      "Created by the generated bundle.",
    ]);

    expect(created).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('Created "bundle-entry"'),
    });
    const inboxEntries = await readdir(path.join(root, "inbox"));
    expect(inboxEntries.toSorted()).toEqual(["bundle-entry.md"]);
  });
});

async function run(args: string[]) {
  return execaNode(cliPath, args);
}

function spawnNode(
  script: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("node", [script, ...args], {
      env: { ...process.env, GOAT_BRAIN_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}
