import { describe, expect, it } from "vitest";
import {
  buildCursorMcpConfig,
  buildCursorMcpDeeplink,
  buildGoatMcpFirstPrompt,
  isGoatMcpClient,
  isGoatMcpSetupCompletionRun,
} from "@/lib/mcp-setup";

describe("Goat MCP setup", () => {
  it("accepts only supported client preferences", () => {
    expect(isGoatMcpClient("claude")).toBe(true);
    expect(isGoatMcpClient("chatgpt")).toBe(true);
    expect(isGoatMcpClient("cursor")).toBe(true);
    expect(isGoatMcpClient("email")).toBe(false);
    expect(isGoatMcpClient(null)).toBe(false);
  });

  it.each([
    { sourceRef: "mcp:call_1", command: "query", ok: true, expected: true },
    { sourceRef: "mcp:call_1", command: "query", ok: false, expected: false },
    { sourceRef: "mcp:call_1", command: "get", ok: true, expected: false },
    { sourceRef: "goat-chat:message_1", command: "query", ok: true, expected: false },
    { sourceRef: null, command: "query", ok: true, expected: false },
  ])("recognizes only a successful MCP query as completion", (input) => {
    expect(isGoatMcpSetupCompletionRun(input)).toBe(input.expected);
  });

  it("builds a deterministic, personalized first question without an email", () => {
    const prompt = buildGoatMcpFirstPrompt({
      displayName: "Ada Lovelace",
      workspaceName: "Analytical Engines",
      brainName: "Company Brain",
    });

    expect(prompt).toContain('query the brain for "Ada Lovelace"');
    expect(prompt).toContain("at Analytical Engines");
    expect(prompt).toContain('connector for "Company Brain"');
    expect(prompt).toContain("Cite the brain pages");
    expect(prompt).not.toContain("@");
  });

  it("builds Cursor config and an install deeplink for the remote URL", () => {
    const input = {
      name: "goat-company-brain",
      url: "https://goat.example/api/mcp/goat_brain_1/mcp",
    };

    expect(buildCursorMcpConfig(input)).toEqual({
      mcpServers: {
        "goat-company-brain": { url: input.url },
      },
    });

    const deeplink = new URL(buildCursorMcpDeeplink(input));
    expect(deeplink.protocol).toBe("cursor:");
    expect(deeplink.searchParams.get("name")).toBe(input.name);
    expect(JSON.parse(atob(deeplink.searchParams.get("config")!))).toEqual({ url: input.url });
  });
});
