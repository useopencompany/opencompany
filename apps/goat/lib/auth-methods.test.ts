import { AuthenticationException } from "@workos-inc/node";
import { cookies } from "next/headers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeGoatOAuthStateCookie,
  organizationSelectionFromError,
  readLastGoatAuthMethod,
  recordLastGoatAuthMethod,
  safeGoatReturnPathname,
  setGoatOAuthStateCookie,
} from "@/lib/auth-methods";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

const cookiesMock = vi.mocked(cookies);

describe("safeGoatReturnPathname", () => {
  it.each([
    ["/", "/"],
    ["/brain?view=recent#today", "/brain?view=recent#today"],
    ["https://attacker.example/steal", "/"],
    ["//attacker.example/steal", "/"],
    ["/\\attacker.example/steal", "/"],
    [undefined, "/"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(safeGoatReturnPathname(input)).toBe(expected);
  });
});

describe("organizationSelectionFromError", () => {
  it("extracts the pending token and valid organizations", () => {
    const error = new AuthenticationException(
      400,
      {
        code: "organization_selection_required",
        pending_authentication_token: "pending-token",
        organizations: [
          { id: "org_one", name: "One" },
          { id: "org_two", name: "Two" },
        ],
      },
      "request-123",
    );

    expect(organizationSelectionFromError(error)).toEqual({
      pendingAuthenticationToken: "pending-token",
      organizations: [
        { id: "org_one", name: "One" },
        { id: "org_two", name: "Two" },
      ],
    });
  });

  it("does not treat other authentication failures as organization selection", () => {
    const error = new AuthenticationException(
      400,
      { code: "email_verification_required", pending_authentication_token: "pending-token" },
      "request-123",
    );

    expect(organizationSelectionFromError(error)).toBeNull();
    expect(organizationSelectionFromError(new Error("network failure"))).toBeNull();
  });
});

describe("recordLastGoatAuthMethod / readLastGoatAuthMethod", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records GoogleOAuth as google and MagicAuth as magic_link", async () => {
    const set = vi.fn();
    cookiesMock.mockResolvedValue({ set } as never);

    await recordLastGoatAuthMethod("GoogleOAuth");
    expect(set).toHaveBeenCalledWith("goat-last-auth-method", "google", expect.any(Object));

    await recordLastGoatAuthMethod("MagicAuth");
    expect(set).toHaveBeenCalledWith("goat-last-auth-method", "magic_link", expect.any(Object));
  });

  it("does not write a cookie for other authentication methods", async () => {
    const set = vi.fn();
    cookiesMock.mockResolvedValue({ set } as never);

    await recordLastGoatAuthMethod(undefined);
    await recordLastGoatAuthMethod("SSO");

    expect(set).not.toHaveBeenCalled();
  });

  it("only trusts known cookie values", async () => {
    cookiesMock.mockResolvedValue({
      get: () => ({ value: "google" }),
    } as never);
    await expect(readLastGoatAuthMethod()).resolves.toBe("google");

    cookiesMock.mockResolvedValue({
      get: () => ({ value: "not-a-real-method" }),
    } as never);
    await expect(readLastGoatAuthMethod()).resolves.toBeNull();
  });
});

describe("setGoatOAuthStateCookie / consumeGoatOAuthStateCookie", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the state cookie with the same path it was set with", async () => {
    const set = vi.fn();
    const get = vi.fn(() => ({ value: JSON.stringify({ state: "abc" }) }));
    const del = vi.fn();
    cookiesMock.mockResolvedValue({ set, get, delete: del } as never);

    await setGoatOAuthStateCookie({ state: "abc" });
    expect(set).toHaveBeenCalledWith(
      "goat-oauth-state",
      JSON.stringify({ state: "abc" }),
      expect.objectContaining({ path: "/", httpOnly: true }),
    );

    const payload = await consumeGoatOAuthStateCookie();
    expect(payload).toEqual({ state: "abc" });
    expect(del).toHaveBeenCalledWith({ name: "goat-oauth-state", path: "/" });
  });

  it("returns null for a missing or malformed cookie without throwing", async () => {
    cookiesMock.mockResolvedValue({
      get: () => undefined,
      delete: vi.fn(),
    } as never);
    await expect(consumeGoatOAuthStateCookie()).resolves.toBeNull();

    cookiesMock.mockResolvedValue({
      get: () => ({ value: "not json" }),
      delete: vi.fn(),
    } as never);
    await expect(consumeGoatOAuthStateCookie()).resolves.toBeNull();

    cookiesMock.mockResolvedValue({
      get: () => ({ value: JSON.stringify({ no: "state field" }) }),
      delete: vi.fn(),
    } as never);
    await expect(consumeGoatOAuthStateCookie()).resolves.toBeNull();
  });
});
