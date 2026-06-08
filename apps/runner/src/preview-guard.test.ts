import { describe, expect, it, vi } from "vitest";
import {
  assertPreviewIdentity,
  neonEndpointIdFromUrl,
  PreviewIdentityError,
  readPreviewIdentity,
} from "./preview-guard";

const PROD_HOST = "ep-prod-endpoint-000000-pooler.c-3.eu-central-1.aws.neon.tech";
const PREVIEW_HOST = "ep-preview-endpoint-123456.c-3.eu-central-1.aws.neon.tech";

function url(host: string) {
  return `postgresql://user:pass@${host}/neondb?sslmode=require`;
}

function neonApi(branchByEndpoint: Record<string, string>) {
  return vi.fn(async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input.toString();
    const match = href.match(/\/endpoints\/([^/?]+)/);
    const endpointId = match?.[1] ? decodeURIComponent(match[1]) : "";
    const branch_id = branchByEndpoint[endpointId];
    if (!branch_id) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify({ endpoint: { id: endpointId, branch_id } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("neonEndpointIdFromUrl", () => {
  it("extracts the endpoint id from a pooled host", () => {
    expect(neonEndpointIdFromUrl(url(PROD_HOST))).toBe("ep-prod-endpoint-000000");
  });

  it("extracts the endpoint id from a direct host", () => {
    expect(neonEndpointIdFromUrl(url(PREVIEW_HOST))).toBe("ep-preview-endpoint-123456");
  });

  it("returns undefined for non-Neon hosts", () => {
    expect(neonEndpointIdFromUrl(url("localhost:5432"))).toBeUndefined();
  });

  it("returns undefined for unparseable urls", () => {
    expect(neonEndpointIdFromUrl("not a url")).toBeUndefined();
  });
});

describe("readPreviewIdentity", () => {
  it("reads the trio and coerces PREVIEW_ENV", () => {
    expect(
      readPreviewIdentity({
        PREVIEW_ENV: "true",
        NEON_BRANCH_ID: "br-abc",
        PREVIEW_PR_NUMBER: "42",
      }),
    ).toEqual({ previewEnv: true, neonBranchId: "br-abc", prNumber: "42" });
  });

  it("treats blank/absent as not-preview", () => {
    expect(readPreviewIdentity({ PREVIEW_ENV: "  " })).toEqual({
      previewEnv: false,
      neonBranchId: undefined,
      prNumber: undefined,
    });
  });
});

describe("assertPreviewIdentity — prod runner (no PREVIEW_ENV)", () => {
  it("passes when no preview identity is present", async () => {
    await expect(
      assertPreviewIdentity({ env: {}, databaseUrl: url(PROD_HOST) }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when a stray NEON_BRANCH_ID is present without PREVIEW_ENV", async () => {
    await expect(
      assertPreviewIdentity({ env: { NEON_BRANCH_ID: "br-stray" }, databaseUrl: url(PROD_HOST) }),
    ).rejects.toThrow(PreviewIdentityError);
  });

  it("fails closed when a stray PREVIEW_PR_NUMBER is present without PREVIEW_ENV", async () => {
    await expect(
      assertPreviewIdentity({ env: { PREVIEW_PR_NUMBER: "9" }, databaseUrl: url(PROD_HOST) }),
    ).rejects.toThrow(/ambiguous preview identity/);
  });
});

describe("assertPreviewIdentity — preview runner", () => {
  const baseEnv = {
    PREVIEW_ENV: "true",
    NEON_BRANCH_ID: "br-preview-pr-42",
    PREVIEW_PR_NUMBER: "42",
    NEON_API_KEY: "neon-key",
    NEON_PROJECT_ID: "proj-1",
  };

  it("passes when the DB endpoint resolves to the declared branch", async () => {
    const fetchImpl = neonApi({ "ep-preview-endpoint-123456": "br-preview-pr-42" });
    await expect(
      assertPreviewIdentity({ env: { ...baseEnv }, databaseUrl: url(PREVIEW_HOST), fetchImpl }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails closed when the endpoint belongs to a DIFFERENT branch (e.g. prod DB)", async () => {
    // The catastrophic case: a preview runner accidentally pointed at the prod endpoint.
    const fetchImpl = neonApi({ "ep-prod-endpoint-000000": "br-prod-main" });
    await expect(
      assertPreviewIdentity({ env: { ...baseEnv }, databaseUrl: url(PROD_HOST), fetchImpl }),
    ).rejects.toThrow(/not the declared NEON_BRANCH_ID/);
  });

  it("requires NEON_BRANCH_ID", async () => {
    await expect(
      assertPreviewIdentity({
        env: { PREVIEW_ENV: "true", PREVIEW_PR_NUMBER: "42" },
        databaseUrl: url(PREVIEW_HOST),
      }),
    ).rejects.toThrow(/requires NEON_BRANCH_ID/);
  });

  it("requires PREVIEW_PR_NUMBER", async () => {
    await expect(
      assertPreviewIdentity({
        env: { PREVIEW_ENV: "true", NEON_BRANCH_ID: "br-x" },
        databaseUrl: url(PREVIEW_HOST),
      }),
    ).rejects.toThrow(/requires PREVIEW_PR_NUMBER/);
  });

  it("requires NEON_API_KEY + NEON_PROJECT_ID to verify", async () => {
    await expect(
      assertPreviewIdentity({
        env: { PREVIEW_ENV: "true", NEON_BRANCH_ID: "br-x", PREVIEW_PR_NUMBER: "42" },
        databaseUrl: url(PREVIEW_HOST),
      }),
    ).rejects.toThrow(/requires NEON_API_KEY and NEON_PROJECT_ID/);
  });

  it("fails closed when the endpoint id cannot be extracted from the URL", async () => {
    await expect(
      assertPreviewIdentity({ env: { ...baseEnv }, databaseUrl: url("localhost:5432") }),
    ).rejects.toThrow(/Could not extract a Neon endpoint id/);
  });

  it("fails closed when the Neon API errors", async () => {
    const fetchImpl = neonApi({}); // 404 for every endpoint
    await expect(
      assertPreviewIdentity({ env: { ...baseEnv }, databaseUrl: url(PREVIEW_HOST), fetchImpl }),
    ).rejects.toThrow(/Neon API returned 404/);
  });

  it("honors the explicit unverified escape hatch without calling the API", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      assertPreviewIdentity({
        env: { ...baseEnv, PREVIEW_ALLOW_UNVERIFIED_ENDPOINT: "true" },
        databaseUrl: url(PROD_HOST),
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
