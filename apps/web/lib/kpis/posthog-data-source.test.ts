import { describe, expect, it, vi } from "vitest";
import { discoverPostHogProfile } from "@/lib/kpis/posthog-data-source";

describe("PostHog KPI data source discovery", () => {
  it("falls back from US to EU cloud host", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          email: "founder@example.com",
          team: { project_id: 123, name: "EU Project" },
        }),
      ) as unknown as typeof fetch;

    await expect(discoverPostHogProfile("token", fetchFn)).resolves.toEqual({
      apiHost: "https://eu.posthog.com",
      me: {
        email: "founder@example.com",
        team: { project_id: 123, name: "EU Project" },
      },
    });
    expect(vi.mocked(fetchFn).mock.calls.map((call) => call[0])).toEqual([
      "https://us.posthog.com/api/users/@me/",
      "https://eu.posthog.com/api/users/@me/",
    ]);
  });

  it("surfaces failure after both cloud hosts reject the token", async () => {
    const fetchFn = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(discoverPostHogProfile("token", fetchFn)).rejects.toThrow(
      "PostHog profile returned 401.",
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
