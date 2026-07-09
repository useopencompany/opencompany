import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderGoatBrainToolCommand, runGoatBrainToolForUser } from "@/lib/brain-cli";

vi.mock("@opencompany/db/goat-brain-read", () => ({
  searchGoatBrain: vi.fn(),
  getGoatBrainDocuments: vi.fn(),
  getGoatBrainTimeline: vi.fn(),
  listGoatBrainDocuments: vi.fn(),
}));

import {
  getGoatBrainDocuments,
  getGoatBrainTimeline,
  listGoatBrainDocuments,
  searchGoatBrain,
} from "@opencompany/db/goat-brain-read";

const BASE_INPUT = {
  brainRef: "goat_brain_user_1",
  userWorkosId: "user_1",
  gatewayApiKey: "gateway_test",
  sourceRef: "goat-chat:user_message_1",
};

describe("runGoatBrainToolForUser", () => {
  it("does not silently ignore stdin for create truth", () => {
    expect(
      renderGoatBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            title: "OpenCompany",
            type: "company",
            json: true,
          },
          stdin: "OpenCompany is a company.",
        },
        "goat-chat:user_message_1",
      ),
    ).toEqual({
      argv: [
        "create",
        "--id",
        "opencompany",
        "--title",
        "OpenCompany",
        "--type",
        "company",
        "--json",
        "--truth-stdin",
        "--source-ref",
        "goat-chat:user_message_1",
      ],
      stdin: "OpenCompany is a company.",
    });
  });

  it("rejects create without an explicit type", () => {
    expect(() =>
      renderGoatBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            title: "OpenCompany",
            truth: "OpenCompany is a company.",
          },
        },
        "goat-chat:user_message_1",
      ),
    ).toThrow("goat_brain create requires a type.");
    expect(() =>
      renderGoatBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            title: "OpenCompany",
            truth: "OpenCompany is a company.",
          },
        },
        "goat-chat:user_message_1",
      ),
    ).toThrow('Relevant help command: { command: "help", flags: { topic: "create" } }.');
  });

  it("rejects create without compiled truth", () => {
    expect(() =>
      renderGoatBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            title: "OpenCompany",
            type: "company",
          },
        },
        "goat-chat:user_message_1",
      ),
    ).toThrow("goat_brain create requires compiled truth");
  });

  it("allows create in any free-form folder", () => {
    expect(
      renderGoatBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "opencompany",
            folder: "accounts/customers",
            title: "OpenCompany",
            type: "company",
            truth: "OpenCompany is a company.",
          },
        },
        "goat-chat:user_message_1",
      ).argv,
    ).toContain("accounts/customers");
  });

  it("rejects create with an invalid kind", () => {
    expect(() =>
      renderGoatBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "ev-opencompany-chat",
            kind: "snapshot",
            title: "OpenCompany chat",
            type: "source",
            truth: "OpenCompany was discussed in chat.",
          },
        },
        "goat-chat:user_message_1",
      ),
    ).toThrow('goat_brain create kind must be "page" or "evidence"');

    expect(
      renderGoatBrainToolCommand(
        {
          command: "create",
          flags: {
            id: "ev-opencompany-chat",
            kind: "evidence",
            folder: "evidence",
            title: "OpenCompany chat",
            type: "source",
            truth: "OpenCompany was discussed in chat.",
          },
        },
        "goat-chat:user_message_1",
      ).argv,
    ).toContain("evidence");
  });

  it("renders goat_brain help invocations", () => {
    expect(
      renderGoatBrainToolCommand(
        {
          command: "help",
          flags: { topic: "create" },
        },
        "goat-chat:user_message_1",
      ),
    ).toEqual({
      argv: ["help", "create"],
    });
  });

  it("passes includeMerged through for list and query", () => {
    expect(
      renderGoatBrainToolCommand(
        {
          command: "query",
          flags: { text: "Sarah Chen", includeMerged: true, json: true },
        },
        "goat-chat:user_message_1",
      ).argv,
    ).toEqual(["query", "--text", "Sarah Chen", "--include-merged", "--json"]);

    expect(
      renderGoatBrainToolCommand(
        {
          command: "list",
          flags: { folder: "people", includeMerged: true, json: true },
        },
        "goat-chat:user_message_1",
      ).argv,
    ).toEqual(["list", "--folder", "people", "--include-merged", "--json"]);
  });

  it("renders append-evidence as an evidence-record command", () => {
    expect(
      renderGoatBrainToolCommand(
        {
          command: "append-evidence",
          flags: {
            id: "opencompany",
            type: "source",
            body: "Acme asked for pricing.",
            json: true,
          },
        },
        "goat-chat:user_message_1",
      ).argv,
    ).toEqual([
      "append-evidence",
      "--id",
      "opencompany",
      "--type",
      "source",
      "--body",
      "Acme asked for pricing.",
      "--json",
      "--source-ref",
      "goat-chat:user_message_1",
    ]);
  });

  it("returns a helpful error for unsupported create entity types", async () => {
    const output = await runGoatBrainToolForUser({
      ...BASE_INPUT,
      toolInput: {
        command: "create",
        flags: {
          id: "jordan-lee",
          title: "Jordan Lee",
          type: "candidate",
          json: true,
        },
      },
    });

    expect(output).toMatchObject({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: expect.stringContaining(
        'Unsupported Goat Brain entity type "candidate". Use one of: person, company, project, meeting, concept, source, analysis, note.',
      ),
    });
    expect(output.error).toContain('Relevant help command: { command: "help"');
  });

  it("does not expose ingest through the chat tool", async () => {
    const output = await runGoatBrainToolForUser({
      ...BASE_INPUT,
      toolInput: {
        command: "ingest",
        flags: { textStdin: true, json: true },
        stdin: "Remember this.",
      } as never,
    });

    expect(output).toMatchObject({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: expect.stringContaining('Unsupported goat_brain command "ingest".'),
    });
    expect(output.error).toContain("For command-specific usage");
  });
});

describe("read plane commands", () => {
  beforeEach(() => {
    vi.mocked(searchGoatBrain).mockReset();
    vi.mocked(getGoatBrainDocuments).mockReset();
    vi.mocked(getGoatBrainTimeline).mockReset();
    vi.mocked(listGoatBrainDocuments).mockReset();
  });

  const HIT = {
    id: "ada",
    title: "Ada",
    type: "person",
    kind: "page",
    folder: "team/gtm",
    status: "active",
    updatedAt: "2026-07-01T00:00:00.000Z",
    score: 0.91,
    signals: ["lexical", "vector"],
    snippet: "Ada leads GTM.",
    neighbors: [{ id: "acme", title: "Acme", relationType: "works_at", direction: "out" as const }],
  };

  it("serves query from the read module with mapped options", async () => {
    vi.mocked(searchGoatBrain).mockResolvedValue([HIT as never]);

    const output = await runGoatBrainToolForUser({
      ...BASE_INPUT,
      toolInput: {
        command: "query",
        flags: {
          text: "who runs gtm",
          folder: "team",
          type: "person",
          limit: "5",
          hops: 1,
          lexicalOnly: true,
          graphDirection: "out",
        },
      },
    });

    expect(searchGoatBrain).toHaveBeenCalledWith(
      expect.objectContaining({ brainRef: "goat_brain_user_1", gatewayApiKey: "gateway_test" }),
      {
        text: "who runs gtm",
        folder: "team",
        type: "person",
        limit: 5,
        hops: 1,
        lexicalOnly: true,
      },
    );
    expect(output.ok).toBe(true);
    expect(output.stdout).toContain("1. [team/gtm] Ada (ada, person, score 0.91");
    expect(output.stdout).toContain("Linked: → works_at acme (Acme)");
    expect(output.stdout).toContain("Next: get ada");
    expect(output.parsed).toEqual({ hits: [HIT] });
    expect(output.traceId).toMatch(/^goat_brain_run_/);
  });

  it("serves get for multiple ids and reports missing ones", async () => {
    vi.mocked(getGoatBrainDocuments).mockResolvedValue({
      documents: [
        {
          requestedId: "ada lovelace",
          id: "ada",
          resolvedVia: "alias",
          title: "Ada",
          folder: "team/gtm",
          kind: "page",
          type: "person",
          status: "active",
          aliases: ["Ada Lovelace"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
          compiledTruth: "Ada leads GTM.",
          timeline: [{ at: "2026-06-01T00:00:00.000Z", evidenceId: "ev-1", body: "Joined." }],
          timelineTotal: 1,
          sources: [],
          links: [{ id: "acme", title: "Acme", relationType: "works_at", direction: "out" }],
        },
      ] as never,
      missing: ["ghost"],
    });

    const output = await runGoatBrainToolForUser({
      ...BASE_INPUT,
      toolInput: {
        command: "get",
        flags: { id: ["ada lovelace", "ghost"] },
      },
    });

    expect(getGoatBrainDocuments).toHaveBeenCalledWith(expect.anything(), [
      "ada lovelace",
      "ghost",
    ]);
    expect(output.ok).toBe(true);
    expect(output.stdout).toContain('# Ada (ada) (resolved from "ada lovelace" via alias)');
    expect(output.stdout).toContain("## Compiled truth");
    expect(output.stdout).toContain("→ works_at acme (Acme)");
    expect(output.stdout).toContain("Not found: ghost");
  });

  it("fails get when nothing resolves", async () => {
    vi.mocked(getGoatBrainDocuments).mockResolvedValue({ documents: [], missing: ["ghost"] });

    const output = await runGoatBrainToolForUser({
      ...BASE_INPUT,
      toolInput: { command: "get", flags: { id: "ghost" } },
    });

    expect(output.ok).toBe(false);
    expect(output.error).toContain('No brain doc found with id "ghost"');
  });

  it("serves timeline and list from the read module", async () => {
    vi.mocked(getGoatBrainTimeline).mockResolvedValue({
      id: "ada",
      entries: [
        {
          at: "2026-06-01T00:00:00.000Z",
          evidenceId: "ev-1",
          summary: "Joined.",
          detail: "",
          sourceRef: "jamie:meeting:1",
          sourceTitle: "Kickoff",
        },
      ],
    });
    vi.mocked(listGoatBrainDocuments).mockResolvedValue([
      {
        id: "ada",
        title: "Ada",
        type: "person",
        kind: "page",
        folder: "team/gtm",
        status: "active",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);

    const timeline = await runGoatBrainToolForUser({
      ...BASE_INPUT,
      toolInput: { command: "timeline", flags: { id: "ada", limit: 10 } },
    });
    expect(getGoatBrainTimeline).toHaveBeenCalledWith(expect.anything(), "ada", { limit: 10 });
    expect(timeline.ok).toBe(true);
    expect(timeline.stdout).toContain("Source: Kickoff (jamie:meeting:1)");

    const list = await runGoatBrainToolForUser({
      ...BASE_INPUT,
      toolInput: { command: "list", flags: { type: "person", limit: 20 } },
    });
    expect(listGoatBrainDocuments).toHaveBeenCalledWith(expect.anything(), {
      type: "person",
      limit: 20,
    });
    expect(list.ok).toBe(true);
    expect(list.stdout).toContain("[team/gtm] Ada (ada, person, active");
  });

  it("rejects invalid read flags before touching the module", async () => {
    const output = await runGoatBrainToolForUser({
      ...BASE_INPUT,
      toolInput: { command: "query", flags: { text: "x", kind: "wiki" } },
    });
    expect(output.ok).toBe(false);
    expect(output.error).toContain('kind must be "page" or "evidence"');
    expect(searchGoatBrain).not.toHaveBeenCalled();
  });
});
