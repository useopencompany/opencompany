import { afterEach, describe, expect, it, vi } from "vitest";
import { PostHogAuthError, queryPostHogEvents } from "./posthog-api";

afterEach(() => vi.restoreAllMocks());

const credential = {
  apiKey: "phx_abcdefghijklmnop",
  projectId: "12345",
  region: "eu" as const,
  createdAt: "2026-09-16T00:00:00.000Z",
};

describe("queryPostHogEvents", () => {
  it("queries the fixed regional host with an ingestion-time tuple cursor", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        results: [
          [
            "event-uuid",
            "signup",
            "user-42",
            "2026-09-16T10:00:00.000Z",
            "2026-09-16T10:01:00.123456Z",
            { plan: "pro" },
          ],
        ],
      }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    const events = await queryPostHogEvents({
      credential,
      eventNames: ["signup"],
      cursorAt: "2026-09-16T09:59:00.000123Z",
      cursorUuid: "previous-uuid",
      upperBound: "2026-09-16T10:02:00.000000Z",
      limit: 500,
      signal: new AbortController().signal,
    });

    expect(events).toEqual([
      expect.objectContaining({
        uuid: "event-uuid",
        event: "signup",
        createdAt: "2026-09-16T10:01:00.123456Z",
        properties: { plan: "pro" },
      }),
    ]);
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://eu.posthog.com/api/projects/12345/query/");
    const body = JSON.parse(request?.body as string) as {
      query: { query: string; values: Record<string, unknown> };
    };
    expect(body.query.query).toContain("created_at = toDateTime64({cursorAt}, 6, 'UTC')");
    expect(body.query.query).toContain("toString(uuid) > {cursorUuid}");
    expect(body.query.query).toContain("event IN {eventNames}");
    expect(body.query.values).toMatchObject({
      eventNames: ["signup"],
      cursorAt: "2026-09-16T09:59:00.000123Z",
      cursorUuid: "previous-uuid",
    });
  });

  it("classifies rejected credentials without advancing the caller's cursor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));
    await expect(
      queryPostHogEvents({
        credential,
        eventNames: ["signup"],
        cursorAt: "2026-09-16T09:59:00.000000Z",
        cursorUuid: "",
        upperBound: "2026-09-16T10:02:00.000000Z",
        limit: 500,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(PostHogAuthError);
  });
});
