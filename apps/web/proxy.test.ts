import { afterEach, describe, expect, it, vi } from "vitest";
import { localHttpsRedirectUrl } from "@/lib/local-https-redirect";
import { isUnauthenticatedPath } from "./proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("localHttpsRedirectUrl", () => {
  it("redirects local HTTP document requests to the configured opencompany HTTPS origin", () => {
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://localhost:3443");

    const redirect = localHttpsRedirectUrl(
      request("http://localhost:3002/tasks/TASK-1?tab=run", {
        accept: "text/html",
        host: "localhost:3002",
      }),
    );

    expect(redirect?.toString()).toBe("https://localhost:3443/tasks/TASK-1?tab=run");
  });

  it("does not redirect when the request already targets the configured HTTPS host", () => {
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://localhost:3443");

    const redirect = localHttpsRedirectUrl(
      request("http://localhost:3002/tasks/TASK-1", {
        accept: "text/html",
        host: "localhost:3443",
      }),
    );

    expect(redirect).toBeNull();
  });

  it("does not redirect API, RSC, or prefetch requests", () => {
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://localhost:3443");

    expect(
      localHttpsRedirectUrl(
        request("http://localhost:3002/api/healthz", {
          accept: "application/json",
          host: "localhost:3002",
        }),
      ),
    ).toBeNull();
    expect(
      localHttpsRedirectUrl(
        request("http://localhost:3002/tasks/TASK-1", {
          accept: "text/html",
          host: "localhost:3002",
          rsc: "1",
        }),
      ),
    ).toBeNull();
    expect(
      localHttpsRedirectUrl(
        request("http://localhost:3002/tasks/TASK-1", {
          accept: "text/html",
          host: "localhost:3002",
          purpose: "prefetch",
        }),
      ),
    ).toBeNull();
  });

  it("does not redirect non-local configured app origins", () => {
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");

    const redirect = localHttpsRedirectUrl(
      request("http://localhost:3002/tasks/TASK-1", {
        accept: "text/html",
        host: "localhost:3002",
      }),
    );

    expect(redirect).toBeNull();
  });
});

describe("opencompany public routes", () => {
  it("allows invitation links to start authentication", () => {
    expect(isUnauthenticatedPath("/auth/invite")).toBe(true);
  });

  it("allows the custom sign-in and sign-up pages without authentication", () => {
    expect(isUnauthenticatedPath("/signin")).toBe(true);
    expect(isUnauthenticatedPath("/signup")).toBe(true);
  });

  it("allows shared chats and their attachment routes without authentication", () => {
    expect(isUnauthenticatedPath("/share/goat_chat_share_123")).toBe(true);
    expect(
      isUnauthenticatedPath(
        "/share/goat_chat_share_123/attachments/goat_chat_msg_1/goat_chat_att_1",
      ),
    ).toBe(true);
  });

  it("allows the Stripe webhook without authentication", () => {
    expect(isUnauthenticatedPath("/api/stripe/webhook")).toBe(true);
  });

  it("keeps normal chats behind authentication", () => {
    expect(isUnauthenticatedPath("/chat/goat_chat_123")).toBe(false);
    expect(isUnauthenticatedPath("/share")).toBe(false);
  });
});

function request(url: string, headers: Record<string, string>) {
  return {
    headers: new Headers(headers),
    nextUrl: new URL(url),
  } as Parameters<typeof localHttpsRedirectUrl>[0];
}
