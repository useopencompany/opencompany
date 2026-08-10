import { describe, expect, it } from "vitest";
import {
  MAX_CAPABILITY_PAYLOAD_STRING_CHARS,
  sanitizeCapabilityResult,
} from "@/lib/capabilities/sanitize";

describe("sanitizeCapabilityResult", () => {
  it("redacts credentials while preserving approved contact data", () => {
    const result = sanitizeCapabilityResult({
      source: "lead",
      action: "lead.find_person_email",
      expectedLimit: 1,
      payload: {
        email: "ada@example.com",
        phone: "+1 555 0100",
        access_token: "secret-token",
        sessionid: "secret-session",
        csrf_token: "secret-csrf",
        nested: {
          authorization: "Bearer secret",
          apiKey: "secret-key",
          pagination_token: "keep-this-cursor",
        },
      },
      totalCostUsdMicros: 360_000,
    });
    expect(result.untrustedProviderData).toBe(true);
    expect(result.securityNotice).toMatch(/untrusted external data/i);
    expect(result.payload).toEqual({
      email: "ada@example.com",
      phone: "+1 555 0100",
      access_token: "[REDACTED]",
      sessionid: "[REDACTED]",
      csrf_token: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        apiKey: "[REDACTED]",
        pagination_token: "keep-this-cursor",
      },
    });
    expect(result.cost).toEqual({ totalUsdMicros: 360_000, state: "settled" });
  });

  it("bounds arrays, strings, nesting, and result counts", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 12; depth += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    const result = sanitizeCapabilityResult({
      source: "x",
      action: "x.search_posts",
      expectedLimit: 2,
      payload: {
        items: [{ text: "a".repeat(5_000) }, { text: "second" }, { text: "must be omitted" }],
        deep,
      },
      resultCount: 99,
      totalCostUsdMicros: null,
    });
    expect(result.resultCount).toBe(2);
    expect(result.cost.state).toBe("settling");
    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain("must be omitted");
    expect(serialized).toContain("more items omitted");
    expect(serialized).toContain("Maximum nesting reached");
    expect(serialized).not.toContain("a".repeat(4_100));
  });

  it("separates billable result limits from nested payload array limits", () => {
    const result = sanitizeCapabilityResult({
      source: "youtube",
      action: "youtube.find_in_transcript",
      expectedLimit: 1,
      payloadArrayLimit: 3,
      payload: {
        matches: [{ text: "first" }, { text: "second" }, { text: "third" }],
      },
      resultCount: 1,
      totalCostUsdMicros: 9_000,
    });

    expect(result.resultCount).toBe(1);
    expect(result.payload).toEqual({
      matches: [{ text: "first" }, { text: "second" }, { text: "third" }],
    });
  });

  it("preserves a validated full transcript under an explicit string limit", () => {
    const transcript = "full transcript ".repeat(2_000);
    const transcriptWithLink = `${transcript} https://youtube.com/watch?v=other123456`;
    const result = sanitizeCapabilityResult({
      source: "youtube",
      action: "youtube.get_transcript",
      expectedLimit: 1,
      payloadStringLimit: transcriptWithLink.length,
      discoverPayloadLinks: false,
      canonicalLinks: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
      payload: { transcript: transcriptWithLink },
      resultCount: 1,
      totalCostUsdMicros: 9_000,
    });

    expect(result.payload).toEqual({ transcript: transcriptWithLink });
    expect(result.canonicalLinks).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);

    const oversized = sanitizeCapabilityResult({
      source: "youtube",
      action: "youtube.get_transcript",
      expectedLimit: 1,
      payloadStringLimit: Number.MAX_SAFE_INTEGER,
      payload: { transcript: "x".repeat(MAX_CAPABILITY_PAYLOAD_STRING_CHARS + 100) },
    });
    expect((oversized.payload as { transcript: string }).transcript).toHaveLength(
      MAX_CAPABILITY_PAYLOAD_STRING_CHARS + 1,
    );
  });

  it("returns only canonical links for the selected platform", () => {
    const result = sanitizeCapabilityResult({
      source: "x",
      action: "x.get_post",
      expectedLimit: 1,
      canonicalLinks: [
        "https://twitter.com/openai/status/123?utm_source=test",
        "https://example.com/not-allowed",
      ],
      payload: {
        text: "See https://x.com/openai/status/123?ref_src=twsrc and ignore https://linkedin.com/in/not-x",
      },
      totalCostUsdMicros: 1_800,
    });
    expect(result.canonicalLinks).toEqual(["https://x.com/openai/status/123"]);
  });

  it("keeps public SEO result links while rejecting local targets", () => {
    const result = sanitizeCapabilityResult({
      source: "seo",
      action: "seo.list_top_pages",
      expectedLimit: 3,
      canonicalLinks: ["https://openai.com/?utm_source=test"],
      payload: {
        pages: [
          { url: "https://openai.com/research/?ref=seo" },
          { url: "https://competitor.example/guide#results" },
          { url: "https://127.0.0.1/private" },
        ],
      },
      totalCostUsdMicros: 2_000,
    });
    expect(result.resultCount).toBe(3);
    expect(result.canonicalLinks).toEqual([
      "https://openai.com/research/",
      "https://competitor.example/guide",
      "https://openai.com/",
    ]);
  });
});
