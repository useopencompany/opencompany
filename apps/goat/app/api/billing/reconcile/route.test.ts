import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileGoatWorkspaceSeatQuantities } from "@/lib/billing/seat-sync";
import { GET } from "./route";

vi.mock("@/lib/billing/seat-sync", () => ({
  reconcileGoatWorkspaceSeatQuantities: vi.fn(),
}));

describe("GET /api/billing/reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", "cron-secret");
  });

  it("rejects requests without the cron bearer secret", async () => {
    const response = await GET(new Request("https://goat.test/api/billing/reconcile"));
    expect(response.status).toBe(401);
    expect(reconcileGoatWorkspaceSeatQuantities).not.toHaveBeenCalled();
  });

  it("reports reconciliation failures without exposing their messages", async () => {
    vi.mocked(reconcileGoatWorkspaceSeatQuantities).mockResolvedValue([
      { workspaceId: "goat_ws_1", ok: true },
      { workspaceId: "goat_ws_2", ok: false, error: "sensitive provider response" },
    ]);
    const response = await GET(
      new Request("https://goat.test/api/billing/reconcile", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ checked: 2, failed: 1 });
  });
});
