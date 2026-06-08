import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRoot } from "../store";
import { appendEvidence } from "./append-evidence";
import { parseArgs } from "./args";
import { create } from "./create";
import { doctor } from "./doctor";
import { get } from "./get";
import type { CommandResult } from "./io";
import { merge } from "./merge";
import { query } from "./query";
import { rewrite } from "./rewrite";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "memory-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(
  handler: (ctx: {
    root: string;
    json: boolean;
    args: ReturnType<typeof parseArgs>;
  }) => Promise<CommandResult>,
  argv: string[],
): Promise<CommandResult> {
  const args = parseArgs(argv);
  return handler({ root: resolveRoot(root), json: true, args });
}

function data(result: CommandResult): Record<string, unknown> {
  return result.data as Record<string, unknown>;
}

describe("memory CLI", () => {
  it("creates a canonical object and rejects duplicates / evidence types", async () => {
    const created = await run(create, ["--type", "company", "--id", "acme", "--alias", "Acme Inc"]);
    expect(created.code).toBe(0);
    expect(data(created).path).toBe("companies/acme.md");

    const dup = await run(create, ["--type", "company", "--id", "acme"]);
    expect(dup.code).toBe(1);

    const evidenceType = await run(create, ["--type", "meeting", "--id", "x"]);
    expect(evidenceType.code).toBe(1);
  });

  it("append-evidence enforces provenance and links subjects without bumping updated_at", async () => {
    await run(create, ["--type", "company", "--id", "acme"]);
    const before = data(await run(get, ["acme", "--section", "frontmatter"]));
    const updatedBefore = before.frontmatter as { updated_at?: string; updatedAt?: string };

    const noProvenance = await run(appendEvidence, [
      "--kind",
      "meeting",
      "--id",
      "acme-call",
      "--subject",
      "acme",
    ]);
    expect(noProvenance.code).toBe(1);

    const ev = await run(appendEvidence, [
      "--kind",
      "meeting",
      "--id",
      "acme-call",
      "--subject",
      "acme",
      "--source-ref",
      "gcal://abc",
      "--summary",
      "Enterprise eval confirmed",
    ]);
    expect(ev.code).toBe(0);
    expect(data(ev).path).toBe("evidence/meetings/acme-call.md");

    const after = data(await run(get, ["acme", "--json"]));
    const timeline = after.timeline as Array<{ body: string }>;
    expect(timeline.some((t) => t.body.includes("[^ev:acme-call]"))).toBe(true);
    // Compiled-truth freshness (updated_at) must be unchanged by evidence capture.
    const fmAfter = after.frontmatter as { updatedAt: string };
    expect(fmAfter.updatedAt).toBe((updatedBefore as { updatedAt: string }).updatedAt);
  });

  it("rewrite requires valid, linked citations", async () => {
    await run(create, ["--type", "company", "--id", "acme"]);
    await run(appendEvidence, [
      "--kind",
      "meeting",
      "--id",
      "acme-call",
      "--subject",
      "acme",
      "--source-ref",
      "gcal://abc",
    ]);

    const noCite = await run(rewrite, ["acme", "--truth", "Acme is a customer."]);
    expect(noCite.code).toBe(1);

    const missing = await run(rewrite, ["acme", "--truth", "Acme is a customer [^ev:nope]."]);
    expect(missing.code).toBe(1);

    const good = await run(rewrite, [
      "acme",
      "--truth",
      "Acme is evaluating enterprise [^ev:acme-call].",
    ]);
    expect(good.code).toBe(0);
    expect(data(good).cited).toEqual(["acme-call"]);
  });

  it("rejects a citation whose evidence does not list the subject", async () => {
    await run(create, ["--type", "company", "--id", "acme"]);
    await run(create, ["--type", "company", "--id", "globex"]);
    await run(appendEvidence, [
      "--kind",
      "meeting",
      "--id",
      "globex-call",
      "--subject",
      "globex",
      "--source-ref",
      "x://y",
    ]);

    const result = await run(rewrite, ["acme", "--truth", "Acme thing [^ev:globex-call]."]);
    expect(result.code).toBe(1);
  });

  it("queries the corpus (lexical)", async () => {
    await run(create, [
      "--type",
      "company",
      "--id",
      "acme",
      "--truth",
      "Acme is a logistics SaaS customer.",
    ]);
    await run(create, [
      "--type",
      "person",
      "--id",
      "jane-doe",
      "--truth",
      "Jane is VP Eng at Acme.",
    ]);

    const result = await run(query, ["logistics", "--lexical-only"]);
    expect(result.code).toBe(0);
    const hits = data(result).hits as Array<{ id: string }>;
    expect(hits[0]?.id).toBe("acme");
  });

  it("merges a duplicate into the survivor and re-points evidence", async () => {
    await run(create, ["--type", "company", "--id", "acme"]);
    await run(create, ["--type", "company", "--id", "acme-corp"]);
    await run(appendEvidence, [
      "--kind",
      "meeting",
      "--id",
      "kickoff",
      "--subject",
      "acme-corp",
      "--source-ref",
      "x://y",
    ]);

    const dry = await run(merge, ["--from", "acme-corp", "--into", "acme", "--dry-run"]);
    expect(data(dry).dryRun).toBe(true);

    const merged = await run(merge, ["--from", "acme-corp", "--into", "acme"]);
    expect(merged.code).toBe(0);

    const stub = data(await run(get, ["acme-corp", "--json"]));
    expect((stub.frontmatter as { status: string }).status).toBe("merged");

    const evidence = data(await run(get, ["kickoff", "--json"]));
    expect((evidence.frontmatter as { subjects: string[] }).subjects).toContain("acme");
    expect((evidence.frontmatter as { subjects: string[] }).subjects).not.toContain("acme-corp");
  });

  it("doctor passes on a healthy tree and flags broken links", async () => {
    await run(create, ["--type", "company", "--id", "acme"]);
    await run(appendEvidence, [
      "--kind",
      "meeting",
      "--id",
      "acme-call",
      "--subject",
      "acme",
      "--source-ref",
      "x://y",
    ]);
    await run(rewrite, ["acme", "--truth", "Acme is a customer [^ev:acme-call]."]);

    const healthy = await run(doctor, []);
    expect(healthy.code).toBe(0);

    // Introduce a dangling related link.
    await run(create, ["--type", "person", "--id", "ghost", "--related", "missing-person"]);
    const broken = await run(doctor, []);
    expect(broken.code).toBe(1);
    const findings = (data(broken).findings as Array<{ code: string }>).map((f) => f.code);
    expect(findings).toContain("broken_related");
  });
});
