import { afterEach, describe, expect, it, vi } from "vitest";
import { validatePostHogEventsConnection } from "./posthog-events";

afterEach(() => vi.restoreAllMocks());

describe("PostHog event connection validation", () => {
  it("checks both event discovery and HogQL query permissions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(Response.json({ results: [[1]] }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    await expect(
      validatePostHogEventsConnection({
        apiKey: "phx_abcdefghijklmnop",
        projectId: "12345",
        region: "eu",
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://eu.posthog.com/api/projects/12345/event_definitions/?limit=1",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://eu.posthog.com/api/projects/12345/query/");
    const queryRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(queryRequest.body as string)).toEqual({
      query: { kind: "HogQLQuery", query: "SELECT 1 LIMIT 1" },
    });
  });

  it("rejects a key that can list definitions but cannot query events", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));

    await expect(
      validatePostHogEventsConnection({
        apiKey: "phx_abcdefghijklmnop",
        projectId: "12345",
        region: "us",
      }),
    ).resolves.toEqual({
      ok: false,
      error:
        "PostHog rejected this key. Use a personal API key with event definition read and query read access.",
    });
  });
});
