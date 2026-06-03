import { describe, expect, it } from "vitest";
import { gitBlobSha } from "./git-blob";

describe("gitBlobSha", () => {
  // Known git blob SHA-1s (verifiable via `printf '...' | git hash-object --stdin`).
  it("matches git hash-object for an empty blob", () => {
    expect(gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("matches git hash-object for 'hello'", () => {
    expect(gitBlobSha("hello")).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
  });

  it("matches git hash-object for 'hello\\n'", () => {
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("is stable and content-addressed (same content → same sha)", () => {
    expect(gitBlobSha("# Competitors\n")).toBe(gitBlobSha("# Competitors\n"));
    expect(gitBlobSha("a")).not.toBe(gitBlobSha("b"));
  });
});
