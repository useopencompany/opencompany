import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmBrainImportAction,
  startBrainImportDiscoveryAction,
  startWikiImportDiscoveryAction,
} from "./brain-import-actions";

vi.mock("next/headers", () => ({ headers: vi.fn() }));

describe("Brain import API actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.example.test");
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        Cookie: "wos-session=sealed",
        Authorization: "Bearer actor-token",
        Origin: "https://my.opencompany.chat",
      }) as never,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("starts discovery through /v1 with an idempotency key and protocol-shaped selection", async () => {
    let upstream: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        upstream = input instanceof Request ? input : new Request(input, init);
        return Response.json(
          {
            data: { importRunId: "gbimp_1", status: "discovering", replayed: false },
            meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
          },
          { status: 201 },
        );
      }),
    );

    await expect(
      startBrainImportDiscoveryAction({
        brainRef: "brain_1",
        companyUrl: "acme.com",
        focus: "Product",
        sourceSelection: {
          public_web: { enabled: true },
          github: {
            enabled: true,
            integrationId: "integration_gh",
            // The loose UI config carries provider events the strict protocol schema rejects;
            // the adapter must send only the GitHub repository scope.
            config: {
              repos: [{ id: "repo_1", fullName: "acme/api" }],
              events: ["pull_request_merged"],
            },
          },
          gmail: {
            enabled: true,
            integrationId: "integration_gmail",
            config: { events: [{ id: "email_received" }] },
          },
        },
      }),
    ).resolves.toEqual({ ok: true, importRunId: "gbimp_1" });

    const request = upstream as unknown as Request;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/v1/brains/brain_1/imports");
    expect(request.headers.get("idempotency-key")).toMatch(/^web-brain-import:/);
    expect(request.headers.get("cookie")).toBe("wos-session=sealed");
    expect(request.headers.get("origin")).toBe("https://my.opencompany.chat");
    await expect(request.json()).resolves.toEqual({
      companyUrl: "acme.com",
      focus: "Product",
      sourceSelection: {
        public_web: { enabled: true },
        github: {
          enabled: true,
          integrationId: "integration_gh",
          config: { repos: [{ id: "repo_1", fullName: "acme/api" }] },
        },
        gmail: { enabled: true, integrationId: "integration_gmail" },
      },
    });
  });

  it("surfaces typed API errors as action failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "conflict",
              message: "This company-context scan is no longer awaiting confirmation.",
              requestId: "request_1",
              retryable: false,
            },
            meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
          },
          { status: 409 },
        ),
      ),
    );

    await expect(
      confirmBrainImportAction({
        brainRef: "brain_1",
        importRunId: "gbimp_1",
        enabledProviders: ["public_web"],
      }),
    ).resolves.toEqual({
      ok: false,
      message: "This company-context scan is no longer awaiting confirmation. (request request_1)",
    });
  });

  it("starts Wiki discovery through the workspace-scoped command route", async () => {
    let upstream: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        upstream = input instanceof Request ? input : new Request(input, init);
        return Response.json(
          {
            data: { importRunId: "gbimp_wiki", status: "discovering", replayed: false },
            meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
          },
          { status: 201 },
        );
      }),
    );

    await expect(
      startWikiImportDiscoveryAction({
        companyUrl: "acme.com",
        sourceSelection: { public_web: { enabled: true } },
      }),
    ).resolves.toEqual({ ok: true, importRunId: "gbimp_wiki" });

    const request = upstream as unknown as Request;
    expect(new URL(request.url).pathname).toBe("/v1/wiki/imports");
    expect(request.headers.get("idempotency-key")).toMatch(/^web-wiki-import:/);
  });
});
