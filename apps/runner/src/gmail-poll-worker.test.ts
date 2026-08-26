import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { listGmailPollCandidates } from "./gmail-poll-worker";

describe("Gmail polling routes", () => {
  it("unions enabled wiki sources with existing brain poll targets", async () => {
    let query: SQL | undefined;
    const db = {
      execute: vi.fn(async (value: SQL) => {
        query = value;
        return [];
      }),
    };

    await expect(listGmailPollCandidates(db as never)).resolves.toEqual([]);

    const compiled = new PgDialect().sqlToQuery(query!);
    expect(compiled.sql).toContain("FROM goat.brain_sources bs");
    expect(compiled.sql).toContain("FROM goat.wiki_sources ws");
    expect(compiled.sql).toContain("bs.enabled = true");
    expect(compiled.sql).toContain("ws.enabled = true");
    expect(compiled.sql).toMatch(/EXISTS[\s\S]+OR EXISTS/u);
  });
});
