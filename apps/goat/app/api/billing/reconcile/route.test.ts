import { releasePendingGoatIngestionReservations } from "@opencompany/db/goat-billing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileGoatSeatQuantities } from "@/lib/billing/seat-sync";
import { GET } from "./route";

vi.mock("@opencompany/db/goat-billing", () => ({
  releasePendingGoatIngestionReservations: vi.fn(),
}));

vi.mock("@/lib/billing/seat-sync", () => ({
  reconcileGoatSeatQuantities: vi.fn(),
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
    expect(reconcileGoatSeatQuantities).not.toHaveBeenCalled();
  });

  it("releases paused ingestion backlogs, reconciles seats, and reports counts", async () => {
    vi.mocked(releasePendingGoatIngestionReservations).mockResolvedValue({
      released: 4,
      failed: 1,
    });
    vi.mocked(reconcileGoatSeatQuantities).mockResolvedValue({
      candidates: 2,
      synced: 2,
      failed: 0,
    });
    const response = await GET(
      new Request("https://goat.test/api/billing/reconcile", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      released: 4,
      failed: 1,
      seats: { candidates: 2, synced: 2, failed: 0 },
    });
  });
});
