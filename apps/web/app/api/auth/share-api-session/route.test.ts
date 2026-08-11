import { withAuth } from "@workos-inc/authkit-nextjs";
import { headers } from "next/headers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

describe("POST /api/auth/share-api-session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WORKOS_COOKIE_DOMAIN", "opencompany.chat");
    vi.stubEnv("NEXT_PUBLIC_GOAT_API_ORIGIN", "https://api.opencompany.chat");
    vi.mocked(withAuth).mockResolvedValue({ user: { id: "user_1" } } as never);
    vi.mocked(headers).mockResolvedValue(
      new Headers({ "x-workos-session": "sealed-session" }) as never,
    );
  });

  it("sets the shared cookie and expires the legacy host-only cookie", async () => {
    const response = await POST(request("https://my.opencompany.chat"));

    expect(response.status).toBe(204);
    const cookies = (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("Max-Age=0");
    expect(cookies[0]).not.toContain("Domain=");
    expect(cookies[1]).toContain("Domain=opencompany.chat");
  });

  it("rejects cross-origin setup before reading the session", async () => {
    const response = await POST(request("https://attacker.example"));

    expect(response.status).toBe(403);
    expect(withAuth).not.toHaveBeenCalled();
  });

  it("fails closed when shared-cookie configuration is missing", async () => {
    vi.stubEnv("WORKOS_COOKIE_DOMAIN", "");

    const response = await POST(request("https://my.opencompany.chat"));

    expect(response.status).toBe(503);
  });
});

function request(origin: string) {
  return new Request("https://my.opencompany.chat/api/auth/share-api-session", {
    method: "POST",
    headers: { Origin: origin },
  });
}
