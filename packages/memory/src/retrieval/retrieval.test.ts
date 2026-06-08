import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../cli/args";
import { create } from "../cli/create";
import { resolveRoot } from "../store";
import { createGateway, parseJsonStringArray } from "./gateway";
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
