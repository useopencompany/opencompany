import {
  isPlausibleRevolutBusinessApiToken,
  loadRevolutBusinessConnection,
  REVOLUT_BUSINESS_API_BASE_URL,
  REVOLUT_BUSINESS_SANDBOX_API_BASE_URL,
  RevolutApiError,
  requestRevolutBusinessApi,
} from "@opencompany/core/integrations/revolut";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("loadRevolutBusinessConnection", () => {
  it("requires a workspace match and plausible short-lived access token", () => {
    vi.stubEnv("REVOLUT_BUSINESS_WORKSPACE_ID", "workspace_1");
    vi.stubEnv("REVOLUT_BUSINESS_API_TOKEN", "oa_prod_testtokenwithenoughlength");
    vi.stubEnv("REVOLUT_BUSINESS_ACCOUNT_LABEL", "Acme Revolut");

    expect(loadRevolutBusinessConnection("workspace_2")).toBeNull();
    expect(loadRevolutBusinessConnection("workspace_1")).toEqual({
      workspaceId: "workspace_1",
      accountLabel: "Acme Revolut",
      apiToken: "oa_prod_testtokenwithenoughlength",
      apiBaseUrl: REVOLUT_BUSINESS_API_BASE_URL,
      environment: "production",
    });
  });

  it("rejects refresh tokens and non-https base URLs", () => {
    vi.stubEnv("REVOLUT_BUSINESS_WORKSPACE_ID", "workspace_1");
    vi.stubEnv("REVOLUT_BUSINESS_API_TOKEN", "refresh_token");
    expect(loadRevolutBusinessConnection("workspace_1")).toBeNull();

    vi.stubEnv("REVOLUT_BUSINESS_API_TOKEN", "oa_sand_testtokenwithenoughlength");
    vi.stubEnv("REVOLUT_BUSINESS_API_BASE_URL", "http://localhost:9999/api/1.0");
    expect(loadRevolutBusinessConnection("workspace_1")).toMatchObject({
      apiBaseUrl: REVOLUT_BUSINESS_SANDBOX_API_BASE_URL,
      environment: "sandbox",
    });
  });
});

describe("isPlausibleRevolutBusinessApiToken", () => {
  it("accepts Revolut access-token prefixes only", () => {
    expect(isPlausibleRevolutBusinessApiToken("oa_prod_1234567890abcdef")).toBe(true);
    expect(isPlausibleRevolutBusinessApiToken("oa_sand_1234567890abcdef")).toBe(true);
    expect(isPlausibleRevolutBusinessApiToken("oa_prod_has whitespace")).toBe(false);
    expect(isPlausibleRevolutBusinessApiToken("sk_live_1234567890abcdef")).toBe(false);
  });
});

describe("requestRevolutBusinessApi", () => {
  it("sends a bearer request to the configured Revolut endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "account_1" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestRevolutBusinessApi({
        connection: {
          workspaceId: "workspace_1",
          accountLabel: "Acme Revolut",
          apiToken: "oa_prod_testtokenwithenoughlength",
          apiBaseUrl: REVOLUT_BUSINESS_API_BASE_URL,
          environment: "production",
        },
        path: "/expenses",
        params: { from: "2026-07-01", to: "2026-08-01", count: 25 },
      }),
    ).resolves.toEqual([{ id: "account_1" }]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://b2b.revolut.com/api/1.0/expenses?from=2026-07-01&to=2026-08-01&count=25",
    );
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer oa_prod_testtokenwithenoughlength",
      Accept: "application/json",
    });
  });

  it("throws a bounded provider error for non-ok responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "unauthorized", message: "The provided access token is invalid." },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(
      requestRevolutBusinessApi({
        connection: {
          workspaceId: "workspace_1",
          accountLabel: "Acme Revolut",
          apiToken: "oa_prod_testtokenwithenoughlength",
          apiBaseUrl: REVOLUT_BUSINESS_API_BASE_URL,
          environment: "production",
        },
        path: "/accounts",
      }),
    ).rejects.toMatchObject({
      name: "RevolutApiError",
      status: 401,
      code: "unauthorized",
      detail: "The provided access token is invalid.",
    } satisfies Partial<RevolutApiError>);
  });
});
