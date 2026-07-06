import { afterEach, describe, expect, it, vi } from "vitest";
import { localGoatHttpsRedirectUrl } from "@/lib/local-https-redirect";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("localGoatHttpsRedirectUrl", () => {
  it("redirects local HTTP document requests to the configured Goat HTTPS origin", () => {
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://localhost:3443");

    const redirect = localGoatHttpsRedirectUrl(
      request("http://localhost:3002/tasks/TASK-1?tab=run", {
        accept: "text/html",
        host: "localhost:3002",
      }),
    );

    expect(redirect?.toString()).toBe("https://localhost:3443/tasks/TASK-1?tab=run");
  });

  it("does not redirect when the request already targets the configured HTTPS host", () => {
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://localhost:3443");

    const redirect = localGoatHttpsRedirectUrl(
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
      localGoatHttpsRedirectUrl(
        request("http://localhost:3002/api/healthz", {
          accept: "application/json",
          host: "localhost:3002",
        }),
      ),
    ).toBeNull();
    expect(
      localGoatHttpsRedirectUrl(
        request("http://localhost:3002/tasks/TASK-1", {
          accept: "text/html",
          host: "localhost:3002",
          rsc: "1",
        }),
      ),
    ).toBeNull();
    expect(
      localGoatHttpsRedirectUrl(
        request("http://localhost:3002/tasks/TASK-1", {
          accept: "text/html",
          host: "localhost:3002",
          purpose: "prefetch",
        }),
      ),
    ).toBeNull();
  });

  it("does not redirect non-local configured app origins", () => {
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://goat.example.com");

    const redirect = localGoatHttpsRedirectUrl(
      request("http://localhost:3002/tasks/TASK-1", {
        accept: "text/html",
        host: "localhost:3002",
      }),
    );

    expect(redirect).toBeNull();
  });
});

function request(url: string, headers: Record<string, string>) {
  return {
    headers: new Headers(headers),
    nextUrl: new URL(url),
  } as Parameters<typeof localGoatHttpsRedirectUrl>[0];
}
