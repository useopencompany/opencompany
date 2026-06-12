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
import { HELP, helpResult, validateCommandArgs } from "./index";
import type { CommandResult } from "./io";
import { link } from "./link";
import { merge } from "./merge";
import { query, resolveSince } from "./query";
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

// Hand-write a valid draft record with a controlled updated_at — the CLI always stamps "now",
// so recency tests need files whose timestamps we pick ourselves.
async function writeRecord(id: string, updatedAt: string, truth: string): Promise<void> {
  await mkdir(path.join(root, "companies"), { recursive: true });
  await writeFile(
    path.join(root, "companies", `${id}.md`),
    `---\nid: ${id}\ntype: company\nstatus: draft\ncreated_at: ${updatedAt}\nupdated_at: ${updatedAt}\n---\n# ${id}\n\n## Compiled truth\n${truth}\n\n## Timeline\n`,
    "utf8",
  );
}

describe("memory CLI", () => {
  it("returns full help text for invalid command usage", () => {
    const unknownCommand = helpResult('Unknown command "wat".');
    expect(unknownCommand.code).toBe(1);
    expect(unknownCommand.text).toContain('Unknown command "wat".');
    expect(unknownCommand.text).toContain("Usage: memory <command> [options]");
    expect(unknownCommand.text).toContain("Commands:");

    const badFlag = validateCommandArgs("query", parseArgs(["acme", "--lmit", "5"]));
    expect(badFlag).toBe('Unknown option "--lmit".');
    expect(helpResult(badFlag ?? "").text).toContain(HELP);

    const extraPositional = validateCommandArgs("get", parseArgs(["acme", "extra"]));
    expect(extraPositional).toBe('Unexpected argument "extra"; get accepts 1 positional argument.');

    expect(
      validateCommandArgs("query", parseArgs(["acme", "blockers", "--limit", "5"])),
    ).toBeNull();
  });

  it("creates a canonical object and rejects duplicates / evidence types", async () => {
    const created = await run(create, ["--type", "company", "--id", "acme", "--alias", "Acme Inc"]);
    expect(created.code).toBe(0);
    expect(data(created).path).toBe("companies/acme.md");

    // New objects start as drafts (uncited scratch) and carry no freshness field.
    const fm = data(await run(get, ["acme", "--json"])).frontmatter as Record<string, unknown>;
    expect(fm.status).toBe("draft");
    expect(fm).not.toHaveProperty("freshness");

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
    // Compiled-truth recency (updated_at) must be unchanged by evidence capture.
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

  it("query returns capped compiled truth, not just the first sentence", async () => {
    await run(create, [
      "--type",
      "company",
      "--id",
      "open-company-gmbh",
      "--truth",
      "OpenCompany GmbH is the German legal entity. Billing address: c/o Invisible Advisory GmbH, Französische Straße 47, 10117 Berlin, Germany.",
    ]);

    const result = await run(query, ["billing address", "--lexical-only"]);
    expect(result.code).toBe(0);
    expect(result.text).toContain("Billing address: c/o Invisible Advisory GmbH");
    expect(result.text).toContain("Next: memory get open-company-gmbh");
    const hits = data(result).hits as Array<{ snippet: string }>;
    expect(hits[0]?.snippet).toContain("Billing address: c/o Invisible Advisory GmbH");
  });

  it("query marks long compiled truth as truncated with a get hint", async () => {
    const longTruth = `Acme billing details. ${"Long detail ".repeat(140)}`;
    await run(create, ["--type", "company", "--id", "acme", "--truth", longTruth]);

    const result = await run(query, ["billing", "--lexical-only"]);
    const hits = data(result).hits as Array<{ snippet: string }>;
    expect(hits[0]?.snippet).toContain("... [truncated; run memory get acme]");
    expect(hits[0]?.snippet.length).toBeLessThan(longTruth.length);
  });

  it("query displays the no-truth placeholder for records without compiled truth", async () => {
    await run(create, ["--type", "company", "--id", "acme", "--alias", "Acme Inc"]);

    const result = await run(query, ["Acme Inc", "--lexical-only"]);
    expect(result.text).toContain("_No compiled truth yet._");
    const hits = data(result).hits as Array<{ snippet: string }>;
    expect(hits[0]?.snippet).toBe("_No compiled truth yet._");
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

  it("link adds, types, and removes directional related edges on canonical objects", async () => {
    await run(create, ["--type", "company", "--id", "acme"]);
    await run(create, ["--type", "person", "--id", "jane"]);

    // Default type is "related".
    const linked = await run(link, ["acme", "--to", "jane"]);
    expect(linked.code).toBe(0);
    expect(data(linked).related).toEqual([{ type: "related", target: "jane" }]);

    // Re-adding the same target updates its type (one edge per target).
    const retyped = await run(link, ["acme", "--to", "jane", "--as", "employs"]);
    expect(data(retyped).related).toEqual([{ type: "employs", target: "jane" }]);

    // An invalid type slug is rejected.
    expect((await run(link, ["acme", "--to", "jane", "--as", "Has Spaces"])).code).toBe(1);

    // Directional: only acme's edges change; jane is untouched.
    const jane = data(await run(get, ["jane", "--json"]));
    expect((jane.frontmatter as { related: unknown[] }).related).toEqual([]);

    // Cannot link to a non-existent target, or to self.
    expect((await run(link, ["acme", "--to", "ghost"])).code).toBe(1);
    expect((await run(link, ["acme", "--to", "acme"])).code).toBe(1);

    // Removing drops the edge.
    const removed = await run(link, ["acme", "--remove", "jane"]);
    expect(removed.code).toBe(0);
    expect(data(removed).related).toEqual([]);
  });

  it("query --hops expands the result set along related edges", async () => {
    await run(create, [
      "--type",
      "company",
      "--id",
      "acme",
      "--truth",
      "Acme is a logistics SaaS customer.",
    ]);
    await run(create, ["--type", "person", "--id", "jane-doe", "--truth", "Jane handles ops."]);
    await run(link, ["acme", "--to", "jane-doe"]);

    // Without hops, a query that only matches acme does not surface jane-doe.
    const base = await run(query, ["logistics", "--lexical-only"]);
    const baseIds = (data(base).hits as Array<{ id: string }>).map((h) => h.id);
    expect(baseIds).toContain("acme");
    expect(baseIds).not.toContain("jane-doe");

    // With --hops 1, jane-doe is pulled in via the related edge.
    const expanded = await run(query, ["logistics", "--lexical-only", "--hops", "1"]);
    const expandedIds = (data(expanded).hits as Array<{ id: string }>).map((h) => h.id);
    expect(expandedIds).toContain("acme");
    expect(expandedIds).toContain("jane-doe");
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
    const janeRelated = (jane.frontmatter as { related: Array<{ target: string }> }).related;
    expect(janeRelated.map((r) => r.target)).not.toContain("acme");
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
    await run(create, [
      "--type",
      "company",
      "--id",
      "acme",
      "--truth",
      "Acme is a logistics SaaS.",
    ]);

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

  it("rejects unknown get sections", async () => {
    await run(create, ["--type", "company", "--id", "acme"]);

    const result = await run(get, ["acme", "--section", "summary"]);
    expect(result.code).toBe(1);
    expect(result.text).toContain("`--section` must be one of");
  });

  it("renders default get as a structured record with recent timeline entries", async () => {
    await run(create, [
      "--type",
      "company",
      "--id",
      "acme",
      "--truth",
      "Acme is a logistics SaaS.",
    ]);
    for (let i = 1; i <= 6; i++) {
      await run(appendEvidence, [
        "--kind",
        "meeting",
        "--id",
        `acme-call-${i}`,
        "--subject",
        "acme",
        "--source-ref",
        `gcal://abc-${i}`,
        "--summary",
        `Timeline entry ${i}`,
      ]);
    }

    const result = await run(get, ["acme"]);
    expect(result.text).toContain("Path: companies/acme.md");
    expect(result.text).toContain("Type: company");
    expect(result.text).toContain("Status: draft");
    expect(result.text).toContain("## Compiled truth");
    expect(result.text).toContain("## Recent timeline");
    expect(result.text.match(/^### /gm)).toHaveLength(5);
    expect(result.text).toContain("Showing 5 of 6 timeline entries");
    expect(result.text).toContain("memory get acme --section timeline");

    const payload = data(result);
    expect((payload.timeline as unknown[]).length).toBe(6);
    expect((payload.recentTimeline as unknown[]).length).toBe(5);

    const timeline = await run(get, ["acme", "--section", "timeline"]);
    expect(timeline.text.match(/^### /gm)).toHaveLength(6);
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
    const activeStub = await run(create, [
      "--type",
      "company",
      "--id",
      "initech",
      "--status",
      "active",
    ]);
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

  it("resolveSince parses relative windows and ISO timestamps", () => {
    const now = Date.parse("2026-06-12T12:00:00.000Z");
    expect(resolveSince("30m", now)).toBe("2026-06-12T11:30:00.000Z");
    expect(resolveSince("24h", now)).toBe("2026-06-11T12:00:00.000Z");
    expect(resolveSince("7d", now)).toBe("2026-06-05T12:00:00.000Z");
    expect(resolveSince("2w", now)).toBe("2026-05-29T12:00:00.000Z");
    expect(resolveSince("2026-06-01T00:00:00Z", now)).toBe("2026-06-01T00:00:00.000Z");
    expect(resolveSince("yesterday", now)).toBeNull();
    expect(resolveSince("0h", now)).toBeNull();
    expect(resolveSince("24 h", now)).toBeNull();
  });

  it("query --since accepts relative windows and filters on updated_at", async () => {
    await run(create, ["--type", "company", "--id", "fresh", "--truth", "Fresh makes widgets."]);
    // A valid record whose updated_at is older than any relative window we use below.
    await writeRecord("stale", "2020-01-01T00:00:00.000Z", "Stale makes widgets too.");

    const all = await run(query, ["widgets", "--lexical-only"]);
    const allIds = (data(all).hits as Array<{ id: string }>).map((h) => h.id);
    expect(allIds).toContain("fresh");
    expect(allIds).toContain("stale");

    const recent = await run(query, ["widgets", "--lexical-only", "--since", "24h"]);
    const recentIds = (data(recent).hits as Array<{ id: string }>).map((h) => h.id);
    expect(recentIds).toEqual(["fresh"]);
    // Hits surface their updated_at so the agent can reason about recency.
    expect(recent.text).toMatch(/updated \d{4}-\d{2}-\d{2}T/);

    const bad = await run(query, ["widgets", "--lexical-only", "--since", "yesterday"]);
    expect(bad.code).toBe(1);
    expect(bad.text).toContain('Invalid --since value "yesterday"');
  });

  it("query with no text and --since lists recent records newest first", async () => {
    const dayMs = 86_400_000;
    await writeRecord("older", new Date(Date.now() - 10 * dayMs).toISOString(), "Older fact.");
    await writeRecord("newer", new Date(Date.now() - 2 * dayMs).toISOString(), "Newer fact.");

    // No text → no lexical/vector signal → pure recency listing within the window.
    const listing = await run(query, ["--lexical-only", "--since", "30d"]);
    const ids = (data(listing).hits as Array<{ id: string }>).map((h) => h.id);
    expect(ids).toEqual(["newer", "older"]);

    const narrow = await run(query, ["--lexical-only", "--since", "5d"]);
    const narrowIds = (data(narrow).hits as Array<{ id: string }>).map((h) => h.id);
    expect(narrowIds).toEqual(["newer"]);
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
