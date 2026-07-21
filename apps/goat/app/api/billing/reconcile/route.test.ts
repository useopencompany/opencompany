import { releasePendingGoatIngestionReservations } from "@opencompany/db/goat-billing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sweepGoatAutoRefills } from "@/lib/billing/auto-refill";
import { GET } from "./route";

vi.mock("@opencompany/db/goat-billing", () => ({
  releasePendingGoatIngestionReservations: vi.fn(),
}));

vi.mock("@/lib/billing/auto-refill", () => ({
  sweepGoatAutoRefills: vi.fn(),
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
    expect(sweepGoatAutoRefills).not.toHaveBeenCalled();
  });

  it("sweeps auto-refills before releasing backlogs so a fresh balance can admit them", async () => {
    const order: string[] = [];
    vi.mocked(sweepGoatAutoRefills).mockImplementation(async () => {
      order.push("autoRefills");
      return { candidates: 2, charged: 1 };
    });
    vi.mocked(releasePendingGoatIngestionReservations).mockImplementation(async () => {
      order.push("release");
      return { released: 4, failed: 1 };
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
      autoRefills: { candidates: 2, charged: 1 },
    });
    expect(order).toEqual(["autoRefills", "release"]);
  });
});
