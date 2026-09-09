import { describe, expect, it } from "vitest";
import { effectiveCapabilityMode } from "../actions/capabilities";
import { discoverConvexCli, runConvexCli } from "./convex-cli";
import { createConvexMcpTicket, verifyConvexMcpTicket } from "./convex-mcp-ticket";
import { CONVEX_TOOL_CAPABILITIES, parseConvexDeployKey } from "./convex-policy";
import tools from "./convex-tools.json";

describe("Convex deployment policy", () => {
  it.each([
    "project:team:project|abcdefgh",
    "preview:team:project|abcdefgh",
    "happy-animal-123|abcdefgh",
    "dev:evil.example|abcdefgh",
    "dev:../secret|abcdefgh",
    "dev:happy-animal-123|abcdefgh\n",
    "https://localhost/key",
  ])("rejects unscoped or unsafe key %s", (key) => expect(parseConvexDeployKey(key)).toBeNull());
  it("accepts scoped deployment keys and sets conservative defaults", () => {
    expect(parseConvexDeployKey("prod:happy-animal-123|abcdefgh=")).toEqual({
      type: "prod",
      name: "happy-animal-123",
    });
    expect(
      ["read", "query", "write", "draft"].map((c) =>
        effectiveCapabilityMode("convex", c as "read", {}),
      ),
    ).toEqual(["on", "ask", "ask", "off"]);
    expect(Object.keys(CONVEX_TOOL_CAPABILITIES).sort()).toEqual(
      ["status", ...tools.map((t) => t.name)].sort(),
    );
  });
  it("verifies audience-bound expiring tickets", () => {
    const { ticket } = createConvexMcpTicket({
      connectionVersion: "version1",
      userWorkosId: "u",
      workspaceId: "w",
      integrationId: "i",
      registrationId: "r",
      operation: { type: "tools/list" },
      secret: "secret",
      now: 1000,
    });
    expect(verifyConvexMcpTicket({ ticket, secret: "secret", now: 2000 })?.aud).toBe(
      "opencompany-convex-mcp",
    );
    expect(verifyConvexMcpTicket({ ticket, secret: "wrong", now: 2000 })).toBeNull();
    expect(verifyConvexMcpTicket({ ticket, secret: "secret", now: 61000 })).toBeNull();
  });
  it("rejects routing overrides and production mutation before starting a process", async () => {
    await expect(
      runConvexCli({
        apiKey: "dev:happy-animal-123|abcdefgh",
        tool: "tables",
        args: { projectDir: "/etc" },
      }),
    ).rejects.toThrow("connected deployment");
    await expect(
      runConvexCli({ apiKey: "prod:happy-animal-123|abcdefgh", tool: "run", args: {} }),
    ).rejects.toThrow("inspection only");
  });
  it("matches the reviewed fixture to actual pinned CLI discovery", async () => {
    expect((await discoverConvexCli()).tools).toEqual(tools);
  }, 15000);
});
