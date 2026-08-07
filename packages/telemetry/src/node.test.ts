import { describe, expect, it } from "vitest";
import { parseOtlpHeaders } from "./node";

describe("parseOtlpHeaders", () => {
  it("parses comma separated OTLP headers", () => {
    expect(parseOtlpHeaders("signoz-ingestion-key=abc, x-test = value ")).toEqual({
      "signoz-ingestion-key": "abc",
      "x-test": "value",
    });
  });
});
