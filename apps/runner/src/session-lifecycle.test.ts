import { describe, expect, it } from "vitest";
import { optionalUserContext } from "./session-lifecycle";

describe("optionalUserContext", () => {
  it("passes explicit first and last name fields from the loaded user row", () => {
    expect(
      optionalUserContext({
        email: "jonas.morgner@example.com",
        firstName: "Jonas",
        lastName: "C. Morgner",
      }),
    ).toEqual({
      userName: "Jonas C. Morgner",
      userFirstName: "Jonas",
      userLastName: "C. Morgner",
      userEmail: "jonas.morgner@example.com",
    });
  });

  it("keeps an email fallback when the auth provider has no profile name", () => {
    expect(
      optionalUserContext({
        email: "ada@example.com",
        firstName: null,
        lastName: null,
      }),
    ).toEqual({
      userEmail: "ada@example.com",
    });
  });
});
