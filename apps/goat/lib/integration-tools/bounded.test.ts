import { describe, expect, it } from "vitest";
import { boundIntegrationToolResult } from "@/lib/integration-tools/bounded";

describe("boundIntegrationToolResult", () => {
  it("passes small values through untouched", () => {
    const value = { messages: [{ text: "hi", ts: "1" }] };
    expect(boundIntegrationToolResult(value)).toEqual({ result: value, truncated: false });
  });

  it("truncates long strings", () => {
    const { result, truncated } = boundIntegrationToolResult({ body: "a".repeat(5000) });
    expect(truncated).toBe(true);
    expect((result as { body: string }).body.length).toBeLessThan(4100);
    expect((result as { body: string }).body.endsWith("… [truncated]")).toBe(true);
  });

  it("caps arrays at 50 items", () => {
    const { result, truncated } = boundIntegrationToolResult(
      Array.from({ length: 80 }, (_, index) => index),
    );
    expect(truncated).toBe(true);
    expect((result as number[]).length).toBe(50);
  });

  it("caps nesting depth", () => {
    let value: unknown = "leaf";
    for (let index = 0; index < 12; index += 1) value = { nested: value };
    const { truncated } = boundIntegrationToolResult(value);
    expect(truncated).toBe(true);
    expect(JSON.stringify(boundIntegrationToolResult(value).result)).toContain("[max depth]");
  });

  it("hard-caps the serialized payload size", () => {
    const { result, truncated } = boundIntegrationToolResult(
      Array.from({ length: 50 }, () => ({ body: "b".repeat(3000) })),
    );
    expect(truncated).toBe(true);
    expect((result as { preview: string }).preview.length).toBe(30_000);
  });
});
