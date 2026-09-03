import { describe, expect, it } from "vitest";
import {
  buildCursorMcpConfig,
  buildCursorMcpDeeplink,
  buildMcpFirstPrompt,
  isMcpClient,
  isMcpSetupCompletionRun,
  MCP_SERVER_NAME,
} from "@/lib/mcp-setup";

describe("opencompany MCP setup", () => {
  it("accepts only supported client preferences", () => {
    expect(isMcpClient("claude")).toBe(true);
    expect(isMcpClient("chatgpt")).toBe(true);
    expect(isMcpClient("cursor")).toBe(true);
    expect(isMcpClient("email")).toBe(false);
    expect(isMcpClient(null)).toBe(false);
  });

  it.each([
    { sourceRef: "mcp:call_1", command: "query", ok: true, expected: true },
    { sourceRef: "mcp:call_1", command: "query", ok: false, expected: false },
    { sourceRef: "mcp:call_1", command: "get", ok: true, expected: false },
    { sourceRef: "goat-chat:message_1", command: "query", ok: true, expected: false },
    { sourceRef: null, command: "query", ok: true, expected: false },
  ])("recognizes only a successful MCP query as completion", (input) => {
    expect(isMcpSetupCompletionRun(input)).toBe(input.expected);
  });

  it("builds a deterministic, personalized first question without an email", () => {
    const prompt = buildMcpFirstPrompt({
      displayName: "Ada Lovelace",
      workspaceName: "Analytical Engines",
    });

    expect(prompt).toContain("Use the opencompany connector");
    expect(prompt).toContain('search it for "Ada Lovelace"');
    expect(prompt).toContain("at Analytical Engines");
    expect(prompt).toContain("workspace Wiki tree");
    expect(prompt).toContain("Cite the Wiki pages");
    expect(prompt).not.toContain("@");
  });

  it("builds Cursor config and an install deeplink for the remote URL", () => {
    const input = {
      name: MCP_SERVER_NAME,
      url: "https://opencompany.example/mcp",
    };

    expect(buildCursorMcpConfig(input)).toEqual({
      mcpServers: {
        opencompany: { url: input.url },
      },
    });

    const deeplink = new URL(buildCursorMcpDeeplink(input));
    expect(deeplink.protocol).toBe("cursor:");
    expect(deeplink.searchParams.get("name")).toBe(input.name);
    expect(JSON.parse(atob(deeplink.searchParams.get("config")!))).toEqual({ url: input.url });
  });
});
