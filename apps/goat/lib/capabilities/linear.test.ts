import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integrations/linear-mcp", () => ({
  GOAT_LINEAR_MCP_ENDPOINT_URL: "https://mcp.linear.app/mcp",
  getGoatLinearIntegrationState: vi.fn(async () => ({ connected: true })),
  loadGoatLinearMcpWorkerConnection: vi.fn(),
}));

import { linearCapability, selectLinearReadTools } from "@/lib/capabilities/linear";
import { getGoatLinearIntegrationState } from "@/lib/integrations/linear-mcp";

function fakeCatalog(names: string[]): ToolSet {
  return Object.fromEntries(names.map((name) => [name, { description: name }])) as ToolSet;
}

describe("selectLinearReadTools", () => {
  it("keeps read tools and hard-excludes mutations", () => {
    const tools = selectLinearReadTools(
      fakeCatalog([
        "list_issues",
        "get_issue",
        "create_issue",
        "update_issue",
        "delete_project",
        "list_comments",
        "create_comment",
        "get_or_create_label",
        "search_documentation",
        "list_my_issues",
      ]),
    );
    const names = Object.keys(tools);
    expect(names).toContain("list_issues");
    expect(names).toContain("get_issue");
    expect(names).toContain("list_comments");
    expect(names).toContain("search_documentation");
    expect(names).toContain("list_my_issues");
    expect(names).not.toContain("create_issue");
    expect(names).not.toContain("update_issue");
    expect(names).not.toContain("delete_project");
    expect(names).not.toContain("create_comment");
    // Read prefix but mutation substring: excluded.
    expect(names).not.toContain("get_or_create_label");
  });

  it("caps the tool set and puts preferred tools first", () => {
    const names = [
      "list_issues",
      "get_issue",
      "list_projects",
      ...Array.from({ length: 20 }, (_, index) => `list_extra_${index}`),
    ];
    const tools = selectLinearReadTools(fakeCatalog(names));
    const selected = Object.keys(tools);
    expect(selected).toHaveLength(12);
    expect(selected[0]).toBe("list_issues");
    expect(selected[1]).toBe("get_issue");
    expect(selected[2]).toBe("list_projects");
  });
});

describe("linearCapability.resolve", () => {
  it("is absent when Linear is not connected", async () => {
    vi.mocked(getGoatLinearIntegrationState).mockResolvedValueOnce({
      connected: false,
    } as never);
    expect(await linearCapability.resolve("user_1")).toBeNull();
  });

  it("produces a CAN/CANNOT index line when connected", async () => {
    vi.mocked(getGoatLinearIntegrationState).mockResolvedValueOnce({
      connected: true,
    } as never);
    const resolved = await linearCapability.resolve("user_1");
    expect(resolved).not.toBeNull();
    expect(resolved?.indexLine).toContain("CAN list and look up issues");
    expect(resolved?.indexLine).toContain("CANNOT create, update");
    expect(resolved?.indexLine.length).toBeLessThan(400);
  });
});
