import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRoot } from "../store";
import { alias } from "./alias";
import { appendEvidence } from "./append-evidence";
import { parseArgs } from "./args";
import { create } from "./create";
import { del } from "./delete";
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

  it("merge consolidates aliases onto the survivor without leaving a duplicate", async () => {
    await run(create, ["--type", "company", "--id", "acme", "--alias", "Acme"]);
    await run(create, ["--type", "company", "--id", "acme-corp"]);

    const merged = await run(merge, ["--from", "acme", "--into", "acme-corp"]);
    expect(merged.code).toBe(0);

    // The survivor owns the alias (and the old id as an alias); the stub keeps none.
    const survivor = data(await run(get, ["acme-corp", "--json"]));
    expect((survivor.frontmatter as { aliases: string[] }).aliases).toContain("Acme");
    const stub = data(await run(get, ["acme", "--json"]));
    expect((stub.frontmatter as { aliases?: string[] }).aliases ?? []).toEqual([]);

    // No duplicate_alias finding should remain.
    const health = await run(doctor, []);
    const codes = (data(health).findings as Array<{ code: string }>).map((f) => f.code);
    expect(codes).not.toContain("duplicate_alias");
  });

  it("alias adds and removes names, rejecting collisions and non-canonical targets", async () => {
    await run(create, ["--type", "company", "--id", "acme"]);
    await run(create, ["--type", "company", "--id", "globex", "--alias", "Globex Inc"]);

    const added = await run(alias, ["acme", "--add", "Acme Inc", "--add", "ACME"]);
    expect(added.code).toBe(0);
    expect(data(added).aliases).toEqual(["Acme Inc", "ACME"]);

    const removed = await run(alias, ["acme", "--remove", "ACME"]);
    expect(removed.code).toBe(0);
    expect(data(removed).aliases).toEqual(["Acme Inc"]);

    // Cannot steal an alias another object already owns.
    const collision = await run(alias, ["acme", "--add", "Globex Inc"]);
    expect(collision.code).toBe(1);

    // Cannot alias an id another object already owns.
    const idCollision = await run(alias, ["acme", "--add", "globex"]);
    expect(idCollision.code).toBe(1);

    // Evidence records reject aliases.
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
    const onEvidence = await run(alias, ["acme-call", "--add", "Nope"]);
    expect(onEvidence.code).toBe(1);

    // The tree stays healthy after alias edits.
    const health = await run(doctor, []);
    const codes = (data(health).findings as Array<{ code: string }>).map((f) => f.code);
    expect(codes).not.toContain("duplicate_alias");
  });

  it("deletes a merged stub cleanly and leaves a healthy tree", async () => {
    await run(create, ["--type", "company", "--id", "acme", "--alias", "Acme"]);
    await run(create, ["--type", "company", "--id", "acme-corp"]);
    await run(merge, ["--from", "acme", "--into", "acme-corp"]);

    // A merged stub has no inbound references, so it deletes without --force.
    const dry = await run(del, ["acme", "--dry-run"]);
    expect(data(dry).requiresForce).toBe(false);
    const deleted = await run(del, ["acme"]);
    expect(deleted.code).toBe(0);

    const gone = await run(get, ["acme", "--json"]);
    expect(gone.code).toBe(2);
    const health = await run(doctor, []);
    expect(health.code).toBe(0);
  });

  it("delete refuses hard references without --force and scrubs soft ones with it", async () => {
    await run(create, ["--type", "company", "--id", "acme"]);
    await run(create, ["--type", "person", "--id", "jane", "--related", "acme"]);
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

    // Evidence is cited by acme's compiled truth → a hard reference → refused without --force.
    const refused = await run(del, ["acme-call"]);
    expect(refused.code).toBe(1);

    const forced = await run(del, ["acme-call", "--force"]);
    expect(forced.code).toBe(0);

    // Deleting acme scrubs jane's related link and the (now subject-less) evidence is reported.
    const deletedAcme = await run(del, ["acme"]);
    expect(deletedAcme.code).toBe(0);
    const jane = data(await run(get, ["jane", "--json"]));
    expect((jane.frontmatter as { related: string[] }).related).not.toContain("acme");
  });

  it("rewrite treats a backslash-escaped [^ev:] as literal prose, not a citation", async () => {
    await run(create, ["--type", "concept", "--id", "memory-syntax"]);
    await run(appendEvidence, [
      "--kind",
      "doc",
      "--id",
      "syntax-doc",
      "--subject",
      "memory-syntax",
      "--source-ref",
      "x://y",
    ]);

    // The escaped occurrence must NOT be validated as a (broken) citation; the real one still is.
    const good = await run(rewrite, [
      "memory-syntax",
      "--truth",
      "Citations use the \\[^ev:some-id] form, e.g. [^ev:syntax-doc].",
    ]);
    expect(good.code).toBe(0);
    expect(data(good).cited).toEqual(["syntax-doc"]);
  });

  it("scopes get --section in the JSON data payload", async () => {
    await run(create, ["--type", "company", "--id", "acme", "--truth", "Acme is a logistics SaaS."]);

    const truth = data(await run(get, ["acme", "--section", "truth"]));
    expect(truth.compiledTruth).toBe("Acme is a logistics SaaS.");
    expect(truth.frontmatter).toBeUndefined();
    expect(truth.timeline).toBeUndefined();

    const fm = data(await run(get, ["acme", "--section", "frontmatter"]));
    expect(fm.frontmatter).toBeDefined();
    expect(fm.compiledTruth).toBeUndefined();

    const all = data(await run(get, ["acme", "--section", "all"]));
    expect(all.frontmatter).toBeDefined();
    expect(all.compiledTruth).toBeDefined();
    expect(all.timeline).toBeDefined();
  });

  it("enforces the create/rewrite citation contract: uncited truth stays a draft", async () => {
    // Uncited truth can start life as a draft (scratch)…
    const draft = await run(create, [
      "--type",
      "company",
      "--id",
      "acme",
      "--truth",
      "Acme is interesting.",
    ]);
    expect(draft.code).toBe(0);
    const draftFm = data(await run(get, ["acme", "--section", "frontmatter"]));
    expect((draftFm.frontmatter as { status: string }).status).toBe("draft");

    // …but it cannot be born `active` with uncited compiled truth.
    const activeUncited = await run(create, [
      "--type",
      "company",
      "--id",
      "globex",
      "--status",
      "active",
      "--truth",
      "Globex is established.",
    ]);
    expect(activeUncited.code).toBe(1);

    // An active stub with no compiled truth is fine.
    const activeStub = await run(create, ["--type", "company", "--id", "initech", "--status", "active"]);
    expect(activeStub.code).toBe(0);
  });

  it("promotes a draft to active when rewrite backs its truth with evidence", async () => {
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

    const rewritten = await run(rewrite, [
      "acme",
      "--truth",
      "Acme is evaluating enterprise [^ev:acme-call].",
    ]);
    expect(rewritten.code).toBe(0);
    expect(data(rewritten).status).toBe("active");

    const fm = data(await run(get, ["acme", "--section", "frontmatter"]));
    expect((fm.frontmatter as { status: string }).status).toBe("active");
  });

  it("query hides merged stubs by default and surfaces them with --include-merged", async () => {
    await run(create, ["--type", "company", "--id", "acme"]);
    await run(create, ["--type", "company", "--id", "acme-corp"]);
    await run(merge, ["--from", "acme-corp", "--into", "acme"]);

    const hidden = await run(query, ["acme-corp", "--lexical-only"]);
    const hiddenIds = (data(hidden).hits as Array<{ id: string }>).map((h) => h.id);
    // The survivor resolves the old name (kept as an alias); the merged stub itself is hidden.
    expect(hiddenIds).toContain("acme");
    expect(hiddenIds).not.toContain("acme-corp");

    const shown = await run(query, ["acme-corp", "--lexical-only", "--include-merged"]);
    const shownIds = (data(shown).hits as Array<{ id: string }>).map((h) => h.id);
    expect(shownIds).toContain("acme-corp");
  });

  it("query hides records that fail strict validation unless --include-invalid", async () => {
    await run(create, ["--type", "company", "--id", "acme", "--truth", "Acme makes widgets."]);
    // A hand-broken file (bad status, missing timestamps) — readable but doctor-invalid.
    await mkdir(path.join(root, "companies"), { recursive: true });
    await writeFile(
      path.join(root, "companies", "broken.md"),
      "---\nid: broken\ntype: company\nstatus: nonsense\n---\n# Broken widgets\n\n## Compiled truth\nBroken makes widgets too.\n\n## Timeline\n",
      "utf8",
    );

    const clean = await run(query, ["widgets", "--lexical-only"]);
    const cleanIds = (data(clean).hits as Array<{ id: string }>).map((h) => h.id);
    expect(cleanIds).toContain("acme");
    expect(cleanIds).not.toContain("broken");

    const withInvalid = await run(query, ["widgets", "--lexical-only", "--include-invalid"]);
    const withInvalidIds = (data(withInvalid).hits as Array<{ id: string }>).map((h) => h.id);
    expect(withInvalidIds).toContain("broken");
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
