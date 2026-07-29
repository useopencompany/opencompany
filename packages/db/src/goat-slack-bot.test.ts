import { drizzle } from "drizzle-orm/neon-http";
import { describe, expect, it, vi } from "vitest";
import { claimGoatSlackBotEvent, getGoatSlackBotThreadParticipation } from "./goat-slack-bot";

describe("claimGoatSlackBotEvent", () => {
  it("claims a new event with a lease that only stale unfinished deliveries can replace", async () => {
    const query = vi.fn(async (_statement: string, _params: unknown[], _options: object) => ({
      rows: [["Ev123"]],
    }));
    const db = drizzle(query as never);
    const now = new Date("2026-07-16T10:00:00.000Z");

    const claim = await claimGoatSlackBotEvent({ eventId: "Ev123", teamId: "T123", now }, db);

    expect(claim).toMatchObject({ eventId: "Ev123" });
    expect(claim?.claimId).toMatch(/^gsbec_[a-f0-9]{32}$/);
    const [statement, params] = query.mock.calls[0]!;
    const normalized = statement.replace(/\s+/g, " ");
    expect(normalized).toContain('on conflict ("event_id") do update');
    expect(normalized).toContain('"completed_at" is null');
    expect(normalized).toContain('"claimed_at" <');
    expect(params).toContain(new Date("2026-07-16T09:55:00.000Z").toISOString());
  });

  it("returns null while another delivery owns the event lease", async () => {
    const query = vi.fn(async (_statement: string, _params: unknown[], _options: object) => ({
      rows: [],
    }));
    const db = drizzle(query as never);

    await expect(
      claimGoatSlackBotEvent({ eventId: "Ev123", teamId: "T123" }, db),
    ).resolves.toBeNull();
  });
});

describe("getGoatSlackBotThreadParticipation", () => {
  it("excludes threads whose latest bot reply is older than the participation TTL", async () => {
    const query = vi.fn(async (_statement: string, _params: unknown[], _options: object) => ({
      rows: [],
    }));
    const db = drizzle(query as never);

    await getGoatSlackBotThreadParticipation(
      {
        teamId: "T123",
        channelId: "C123",
        threadTs: "1784196000.000100",
        now: new Date("2026-07-31T12:00:00.000Z"),
      },
      db,
    );

    const [statement, params] = query.mock.calls[0]!;
    const normalized = statement.replace(/\s+/g, " ");
    expect(normalized).toContain('"updated_at" >=');
    expect(params).toContain(new Date("2026-07-01T12:00:00.000Z").toISOString());
  });
});
