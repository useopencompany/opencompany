import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendEvidence } from "../cli/append-evidence";
import { parseArgs } from "../cli/args";
import { create } from "../cli/create";
import { resolveRoot } from "../store";
import { createGateway, type GatewayUsageEntry, parseJsonStringArray } from "./gateway";
import { query } from "./index";
import { buildProviders, loadProviders } from "./providers";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "memory-retrieval-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function seed(argv: string[]) {
  return create({ root: resolveRoot(root), json: true, args: parseArgs(argv) });
}

function evidence(argv: string[]) {
  return appendEvidence({ root: resolveRoot(root), json: true, args: parseArgs(argv) });
}

describe("parseJsonStringArray", () => {
  it("extracts a JSON array from fenced or prose output", () => {
    expect(parseJsonStringArray('```json\n["a","b"]\n```')).toEqual(["a", "b"]);
    expect(parseJsonStringArray('here: ["x", "y"] done')).toEqual(["x", "y"]);
    expect(parseJsonStringArray("no array")).toEqual([]);
  });
});

describe("gateway (mocked fetch)", () => {
  it("posts to the embeddings and chat endpoints with auth", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith("/embeddings")) {
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '["a"]' } }] }), {
        status: 200,
      });
    });
    const gateway = createGateway({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch });

    expect(await gateway.embed(["hi"])).toEqual([[1, 0]]);
    expect(await gateway.chat("q")).toBe('["a"]');
    const [, embedInit] = fetchMock.mock.calls[0] ?? [];
    expect((embedInit as RequestInit | undefined)?.headers).toMatchObject({
      authorization: "Bearer k",
    });
  });

  it("reports token usage (and Gateway-reported cost) per call via onUsage", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/embeddings")) {
        return new Response(
          JSON.stringify({
            data: [{ embedding: [1, 0] }],
            usage: { prompt_tokens: 12, total_tokens: 12 },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '["a"]' } }],
          usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37, cost: 0.0009 },
        }),
        { status: 200 },
      );
    });
    const entries: GatewayUsageEntry[] = [];
    const gateway = createGateway({
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
      onUsage: (entry) => entries.push(entry),
    });

    await gateway.embed(["hi"]);
    await gateway.chat("q");

    expect(entries).toEqual([
      {
        model: "openai/text-embedding-3-small",
        operation: "embeddings",
        inputTokens: 12,
        outputTokens: 0,
        totalTokens: 12,
        costUsd: null,
      },
      {
        model: "openai/gpt-5.4-nano",
        operation: "chat",
        inputTokens: 30,
        outputTokens: 7,
        totalTokens: 37,
        costUsd: 0.0009,
      },
    ]);
  });
});

describe("loadProviders", () => {
  it("returns no providers without an API key", async () => {
    expect(await loadProviders({} as NodeJS.ProcessEnv)).toEqual({});
  });

  it("builds providers when the key is present", async () => {
    const providers = await loadProviders({
      VERCEL_AI_GATEWAY_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(typeof providers.embedTexts).toBe("function");
    expect(typeof providers.expand).toBe("function");
    expect(typeof providers.rerank).toBe("function");
  });
});

describe("full hybrid query (fake gateway)", () => {
  it("fuses lexical + vector and applies rerank", async () => {
    await seed(["--type", "company", "--id", "acme", "--truth", "Acme is a logistics SaaS."]);
    await seed(["--type", "person", "--id", "jane-doe", "--truth", "Jane runs operations."]);

    // Fake gateway: embeddings put "jane-doe" closest to the query; rerank forces "acme" first.
    const gateway = {
      async embed(texts: string[]) {
        return texts.map((t) =>
          t.includes("logistics") ? [1, 0] : t.includes("Jane") ? [0.9, 0.1] : [0.95, 0.05],
        );
      },
      async chat(prompt: string) {
        if (prompt.startsWith("Rank")) return '["acme", "jane-doe"]';
        return '["logistics operations"]';
      },
    };
    const providers = buildProviders(gateway);

    const hits = await query(resolveRoot(root), { text: "ops", limit: 5 }, providers);
    expect(hits.map((h) => h.id)).toContain("acme");
    // Rerank put acme first.
    expect(hits[0]?.id).toBe("acme");
  });

  it("caps record text passed to model-backed rerank", async () => {
    const longTruth = `Acme billing details. ${"Long truth detail ".repeat(120)}`;
    await seed(["--type", "company", "--id", "acme", "--truth", longTruth]);
    await seed(["--type", "company", "--id", "globex", "--truth", "Globex billing details."]);
    for (let i = 0; i < 12; i++) {
      await evidence([
        "--kind",
        "meeting",
        "--id",
        `acme-call-${i}`,
        "--subject",
        "acme",
        "--source-ref",
        `gcal://acme-${i}`,
        "--summary",
        `Billing timeline ${i}. ${"Long timeline detail ".repeat(80)}TAIL_MARKER`,
      ]);
    }

    let candidates: Array<{ id: string; text: string }> = [];
    await query(
      resolveRoot(root),
      { text: "billing", limit: 5 },
      {
        async rerank(_query, records) {
          candidates = records;
          return records.map((record) => record.id);
        },
      },
    );

    const acme = candidates.find((candidate) => candidate.id === "acme");
    expect(acme?.text).toContain("[truncated compiled truth]");
    expect(acme?.text).toContain("[truncated timeline]");
    expect(acme?.text.length).toBeLessThan(2300);
    expect(acme?.text).not.toContain("TAIL_MARKER");
  });

  it("pulls in a linked neighbor with --hops that the text alone would not surface", async () => {
    await seed([
      "--type",
      "company",
      "--id",
      "acme",
      "--truth",
      "Acme is a logistics company.",
      "--related",
      "sea-expansion",
    ]);
    await seed([
      "--type",
      "decision",
      "--id",
      "sea-expansion",
      "--truth",
      "Expand into maritime freight.",
    ]);

    // "logistics" only matches acme directly.
    const flat = await query(resolveRoot(root), { text: "logistics", limit: 5, lexicalOnly: true });
    expect(flat.map((h) => h.id)).toEqual(["acme"]);

    // With one hop, the linked decision is pulled in via acme's `related` edge.
    const hopped = await query(resolveRoot(root), {
      text: "logistics",
      limit: 5,
      lexicalOnly: true,
      hops: 1,
    });
    expect(hopped.map((h) => h.id)).toContain("sea-expansion");
    // The direct text hit still ranks above the graph neighbor.
    expect(hopped[0]?.id).toBe("acme");
  });

  it("foregrounds the record a query names by alias over an incidental mention", async () => {
    await seed([
      "--type",
      "company",
      "--id",
      "shopify-co",
      "--alias",
      "Shopify simulation company",
    ]);
    await seed([
      "--type",
      "decision",
      "--id",
      "shopify-sea",
      "--truth",
      "Shopify simulation company should expand into SEA.",
    ]);

    const hits = await query(
      resolveRoot(root),
      { text: "Shopify simulation company", limit: 5, lexicalOnly: true },
      {},
    );
    // The company owns that exact alias, so it leads despite the decision also mentioning it.
    expect(hits[0]?.id).toBe("shopify-co");
  });

  it("degrades to lexical when lexicalOnly is set (providers ignored)", async () => {
    await seed(["--type", "company", "--id", "acme", "--truth", "logistics SaaS"]);
    const gateway = {
      embed: vi.fn(),
      chat: vi.fn(),
    };
    const hits = await query(
      resolveRoot(root),
      { text: "logistics", limit: 5, lexicalOnly: true },
      buildProviders(gateway as never),
    );
    expect(hits[0]?.id).toBe("acme");
    expect(gateway.embed).not.toHaveBeenCalled();
    expect(gateway.chat).not.toHaveBeenCalled();
  });
});
