import { describe, expect, it, vi } from "vitest";
import {
  listEnabledSlackWikiSourceRoutes,
  parseSlackWikiSourceConfig,
  slackSelectedConversationIds,
} from "./slack";

describe("opencompany Slack wiki source routing", () => {
  it("matches selected channels and DMs while dropping malformed config", () => {
    const config = parseSlackWikiSourceConfig({
      channels: [
        { id: " C123 ", name: " product " },
        { id: "", name: "ignored" },
      ],
      dms: [{ id: "D456", name: "Ada" }, { nope: true }],
    });

    expect(config).toEqual({
      channels: [{ id: "C123", name: "product" }],
      dms: [{ id: "D456", name: "Ada" }],
    });
    const selected = slackSelectedConversationIds(config);
    expect(selected.has("C123")).toBe(true);
    expect(selected.has("D456")).toBe(true);
    expect(selected.has("C999")).toBe(false);
  });

  it("resolves enabled wiki rows into workspace-scoped routes", async () => {
    const rows = [
      {
        integrationId: "integration_1",
        workspaceId: "workspace_1",
        config: { channels: [{ id: "C123", name: "product" }] },
      },
    ];
    const where = vi.fn(async () => rows);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where })),
      })),
    };

    await expect(listEnabledSlackWikiSourceRoutes(["integration_1"], db)).resolves.toEqual([
      {
        integrationId: "integration_1",
        workspaceId: "workspace_1",
        config: { channels: [{ id: "C123", name: "product" }] },
      },
    ]);
    expect(where).toHaveBeenCalledOnce();
  });
});
