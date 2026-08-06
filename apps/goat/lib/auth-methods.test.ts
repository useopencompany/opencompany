import { AuthenticationException } from "@workos-inc/node";
import { describe, expect, it } from "vitest";
import { organizationSelectionFromError, safeGoatReturnPathname } from "@/lib/auth-methods";

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
