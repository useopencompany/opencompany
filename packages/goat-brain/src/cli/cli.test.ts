import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGoatBrainCliSource } from "../generated/cli-bundle";
import { DEFAULT_GOAT_BRAIN_FOLDERS } from "../schema";
import { parseArgs } from "./args";
import { commandHelp, HELP, ingestCommandExitCode, validateCommandArgs } from "./index";
import { fail, ok } from "./io";
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
    expect(validateCommandArgs("toString", parseArgs(["--nope"]))).toBeNull();
    expect(HELP).toContain("goat-brain <command>");
    expect(HELP).toContain("help");
    expect(HELP).toContain("doctor");
    expect(commandHelp("create")).toContain("Usage: goat-brain create");
  });

  it("protects reserved JSON result fields", () => {
    expect(ok("done", { ok: false, error: "bad" }).data).toMatchObject({ ok: true });
    expect(fail("failed", 1, { ok: true, error: "bad" }).data).toMatchObject({
      ok: false,
      error: "failed",
    });
  });

  it("prints global and command-specific help", async () => {
    await expect(run(["help"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("goat-brain - folder-first personal brain CLI"),
    });
    await expect(run(["help", "create"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Usage: goat-brain create"),
    });
    await expect(run(["create", "--help"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Usage: goat-brain create"),
    });
  });

  it("includes help for unknown commands, unknown options, and wrong invocation", async () => {
    await expect(run(["wat"])).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('Unknown command "wat".'),
    });
    await expect(run(["wat"])).resolves.toMatchObject({
      stderr: expect.stringContaining("Usage: goat-brain <command>"),
    });

    await expect(run(["query", "--wat"])).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('Unknown option "--wat".'),
    });
    await expect(run(["query", "--wat"])).resolves.toMatchObject({
      stderr: expect.stringContaining("Usage: goat-brain query"),
    });

    await expect(run(["get", "--root", root])).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("Provide a brain id."),
    });
    await expect(run(["get", "--root", root])).resolves.toMatchObject({
      stderr: expect.stringContaining("Usage: goat-brain get"),
    });

    await expect(
      run(["create", "--root", root, "--folder", "companies", "--id", "acme", "--title", "Acme"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("`--type` is required."),
    });
    await expect(
      run([
        "create",
        "--root",
        root,
        "--folder",
        "people",
        "--type",
        "company",
        "--id",
        "acme",
        "--title",
        "Acme",
        "--truth",
        "Acme is a company.",
      ]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('`--folder` "people" does not match type "company"'),
    });
    await expect(
      run([
        "create",
        "--root",
        root,
        "--folder",
        "companies",
        "--type",
        "company",
        "--id",
        "acme",
        "--title",
        "Acme",
      ]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("`--truth` or `--truth-stdin` is required."),
    });
  });

  it("lists the system default folders", async () => {
    const listed = await run(["folder", "--root", root, "list"]);

    expect(listed).toMatchObject({ exitCode: 0 });
    expect(listed.stdout.trim().split("\n").toSorted()).toEqual(
      [...DEFAULT_GOAT_BRAIN_FOLDERS].toSorted(),
    );
  });

  it("defaults create folders from type and rejects unknown folder roots", async () => {
    await expect(
      run([
        "create",
        "--root",
        root,
        "--type",
        "company",
        "--id",
        "acme",
        "--title",
        "Acme",
        "--truth",
        "Acme is a company.",
        "--json",
      ]),
    ).resolves.toMatchObject({ exitCode: 0 });

    const created = JSON.parse((await run(["get", "--root", root, "acme", "--json"])).stdout) as {
      doc: { frontmatter: { folder: string; type: string } };
    };
    expect(created.doc.frontmatter).toMatchObject({ folder: "companies", type: "company" });

    await expect(
      run(["folder", "--root", root, "create", "--path", "random"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("must be under a known type folder"),
    });
  });

  it("lists brain docs without retrieval", async () => {
    await expect(
      run([
        "create",
        "--root",
        root,
        "--folder",
        "projects",
        "--type",
        "project",
        "--id",
        "launch-plan",
        "--title",
        "Launch plan",
        "--truth",
        "Launch plan is a project.",
      ]),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      run([
        "create",
        "--root",
        root,
        "--folder",
        "people",
        "--type",
        "person",
        "--id",
        "jane",
        "--title",
        "Jane",
        "--truth",
        "Jane is a person.",
      ]),
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
        "projects",
        "--type",
        "project",
        "--id",
        "launch-plan",
        "--title",
        "Launch plan",
        "--truth",
        "Launch plan is a project.",
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
      run([
        "create",
        "--root",
        root,
        "--folder",
        "people",
        "--type",
        "person",
        "--id",
        "jane",
        "--title",
        "Jane",
        "--truth",
        "Jane is a person.",
      ]),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      run(["link", "--root", root, "launch-plan", "--to", "jane", "--as", "owner"]),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      run(["link", "--root", root, "launch-plan", "--to", "jane", "--as", "attended"]),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      run(["move", "--root", root, "launch-plan", "--folder", "people"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('`--folder` "people" does not match type "project"'),
    });

    const linked = JSON.parse(
      (await run(["get", "--root", root, "launch-plan", "--section", "frontmatter", "--json"]))
        .stdout,
    ) as { frontmatter: { relations: Array<{ type: string; to: string }> } };
    expect(linked.frontmatter.relations).toEqual([
      { type: "attended", to: "jane" },
      { type: "owner", to: "jane" },
    ]);

    const get = await run(["get", "--root", root, "launch-plan", "--section", "truth"]);
    expect(get.stdout).toContain("founder-led beta");
    await expect(
      run(["get", "--root", root, "launch-plan", "--section", "unknown"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("`--section` must be all, frontmatter, truth, or timeline."),
    });

    const query = await run(["query", "--root", root, "founder beta", "--lexical-only"]);
    expect(query.stdout).toContain("launch-plan");

    await expect(run(["doctor", "--root", root])).resolves.toMatchObject({
      exitCode: 0,
    });
  });

  it("adds and reads sourced timeline entries through gbrain-style commands", async () => {
    await expect(
      run([
        "create",
        "--root",
        root,
        "--folder",
        "concepts",
        "--type",
        "concept",
        "--id",
        "timeline-note",
        "--title",
        "Timeline note",
        "--truth",
        "Timeline note is a concept.",
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

  it("generates unique evidence ids for multiple updates from one chat source", async () => {
    await expect(
      run([
        "create",
        "--root",
        root,
        "--folder",
        "people",
        "--type",
        "person",
        "--id",
        "sarah-chen",
        "--title",
        "Sarah Chen",
        "--truth",
        "Sarah Chen is an investor.",
      ]),
    ).resolves.toMatchObject({ exitCode: 0 });

    const first = await run([
      "timeline-add",
      "--root",
      root,
      "sarah-chen",
      "--at",
      "2026-07-06T12:00:00.000Z",
      "--body",
      "Sarah asked for the data room.",
      "--source-ref",
      "goat-chat:message_1",
      "--json",
    ]);
    const second = await run([
      "timeline-add",
      "--root",
      root,
      "sarah-chen",
      "--at",
      "2026-07-06T12:00:00.000Z",
      "--body",
      "Sarah wants a partner meeting next week.",
      "--source-ref",
      "goat-chat:message_1",
      "--json",
    ]);

    expect(first).toMatchObject({ exitCode: 0 });
    expect(second).toMatchObject({ exitCode: 0 });
    const firstParsed = JSON.parse(first.stdout) as { evidenceId: string };
    const secondParsed = JSON.parse(second.stdout) as { evidenceId: string };
    expect(firstParsed.evidenceId).not.toBe(secondParsed.evidenceId);

    const timeline = await run(["timeline", "--root", root, "sarah-chen", "--json"]);
    const parsed = JSON.parse(timeline.stdout) as {
      timeline: Array<{ evidenceId: string }>;
    };
    expect(new Set(parsed.timeline.map((entry) => entry.evidenceId)).size).toBe(2);
  });

  it("hides merged docs from list and query unless explicitly included", async () => {
    await expect(
      run([
        "create",
        "--root",
        root,
        "--folder",
        "people",
        "--type",
        "person",
        "--id",
        "sarah-chen",
        "--title",
        "Sarah Chen",
        "--truth",
        "Sarah Chen is the lead investor prospect.",
      ]),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      run([
        "create",
        "--root",
        root,
        "--folder",
        "people",
        "--type",
        "person",
        "--id",
        "sarah-chen-dup",
        "--title",
        "Sarah Chen VC",
        "--truth",
        "Sarah Chen VC is a duplicate investor note.",
      ]),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      run(["merge", "--root", root, "--from", "sarah-chen-dup", "--into", "sarah-chen"]),
    ).resolves.toMatchObject({ exitCode: 0 });

    const listed = JSON.parse(
      (await run(["list", "--root", root, "--folder", "people", "--json"])).stdout,
    ) as { docs: Array<{ id: string }> };
    expect(listed.docs.map((doc) => doc.id)).toEqual(["sarah-chen"]);

    const query = JSON.parse(
      (await run(["query", "--root", root, "Sarah Chen", "--lexical-only", "--json"])).stdout,
    ) as { hits: Array<{ id: string }> };
    expect(query.hits.map((hit) => hit.id)).not.toContain("sarah-chen-dup");

    const included = JSON.parse(
      (
        await run([
          "query",
          "--root",
          root,
          "Sarah Chen",
          "--lexical-only",
          "--include-merged",
          "--json",
        ])
      ).stdout,
    ) as { hits: Array<{ id: string }> };
    expect(included.hits.map((hit) => hit.id)).toContain("sarah-chen-dup");
  });

  it("warns about possible duplicates when creating similar docs", async () => {
    await expect(
      run([
        "create",
        "--root",
        root,
        "--folder",
        "people",
        "--type",
        "person",
        "--id",
        "sarah-chen-basecamp",
        "--title",
        "Sarah Chen Basecamp Ventures",
        "--truth",
        "Sarah Chen invests in seed infrastructure startups.",
      ]),
    ).resolves.toMatchObject({ exitCode: 0 });

    const created = await run([
      "create",
      "--root",
      root,
      "--folder",
      "people",
      "--type",
      "person",
      "--id",
      "sarah-chen-quick-note",
      "--title",
      "Sarah Chen VC",
      "--truth",
      "Sarah Chen is an investor at Basecamp Ventures.",
      "--json",
    ]);
    const parsed = JSON.parse(created.stdout) as {
      warnings?: { possibleDuplicates?: Array<{ id: string }> };
    };

    expect(parsed.warnings?.possibleDuplicates).toEqual([
      expect.objectContaining({ id: "sarah-chen-basecamp" }),
    ]);
  });

  it("does not fail ingest for pre-existing health errors outside applied docs", () => {
    expect(
      ingestCommandExitCode({
        applied: [{ id: "new-person" }],
        failed: [{ id: "failed-person" }],
        health: null,
      }),
    ).toBe(1);
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
    const bundlePath = path.join(root, "goat-brain.mjs");
    await writeFile(bundlePath, getGoatBrainCliSource(), "utf8");

    const created = await spawnNode(bundlePath, [
      "create",
      "--folder",
      "inbox",
      "--type",
      "note",
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
  return new Promise((resolve, reject) => {
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
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}
