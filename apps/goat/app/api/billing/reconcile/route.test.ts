import { releasePendingGoatIngestionReservations } from "@opencompany/db/goat-billing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@opencompany/db/goat-billing", () => ({
  releasePendingGoatIngestionReservations: vi.fn(),
}));

describe("GET /api/billing/reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", "cron-secret");
  });

  it("rejects requests without the cron bearer secret", async () => {
    const response = await GET(new Request("https://goat.test/api/billing/reconcile"));
    expect(response.status).toBe(401);
    expect(releasePendingGoatIngestionReservations).not.toHaveBeenCalled();
  });

  it("releases paused ingestion backlogs and reports the count", async () => {
    vi.mocked(releasePendingGoatIngestionReservations).mockResolvedValue({
      released: 4,
      failed: 1,
    });
    const response = await GET(
      new Request("https://goat.test/api/billing/reconcile", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ released: 4, failed: 1 });
  });
});
