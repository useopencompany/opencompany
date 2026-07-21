import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integrations/linear-mcp", () => ({
  GOAT_LINEAR_MCP_ENDPOINT_URL: "https://mcp.linear.app/mcp",
  getGoatLinearIntegrationState: vi.fn(async () => ({ connected: true })),
  loadGoatLinearMcpWorkerConnection: vi.fn(),
}));

import {
  linearCapability,
  normalizeLinearListIssuesInput,
  selectLinearReadTools,
} from "@/lib/capabilities/linear";
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
        "get_issue_and_archive",
        "list_then_delete",
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
    expect(names).not.toContain("get_issue_and_archive");
    expect(names).not.toContain("list_then_delete");
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

  it("normalizes list_issues arguments before calling Linear", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const tools = selectLinearReadTools({
      list_issues: {
        description: "List issues",
        inputSchema: { type: "object" },
        execute,
      },
    } as never);

    await tools.list_issues?.execute?.(
      {
        team: " Goat ",
        state: "Todo",
        project: "",
        cursor: "",
        priority: 0,
        assignee: null,
        unassigned: false,
        unprioritized: false,
        includeArchived: false,
      },
      { toolCallId: "call_1", messages: [] },
    );

    expect(execute).toHaveBeenCalledWith(
      { team: "Goat", state: "Todo", includeArchived: false },
      expect.objectContaining({ toolCallId: "call_1" }),
    );
  });
});

describe("normalizeLinearListIssuesInput", () => {
  it("drops model placeholder values that Linear treats as active filters", () => {
    expect(
      normalizeLinearListIssuesInput({
        limit: 100,
        cursor: "",
        orderBy: "updatedAt",
        query: "",
        team: "Goat",
        state: "Todo",
        cycle: "",
        label: "",
        assignee: null,
        delegate: "",
        project: "company brain",
        release: "",
        priority: 0,
        parentId: "",
        createdAt: "",
        updatedAt: "",
        includeArchived: false,
      }),
    ).toEqual({
      limit: 100,
      orderBy: "updatedAt",
      team: "Goat",
      state: "Todo",
      project: "company brain",
      includeArchived: false,
    });
  });

  it("maps explicit unassigned and no-priority filters to Linear sentinels", () => {
    expect(
      normalizeLinearListIssuesInput({
        team: "Goat",
        unassigned: true,
        unprioritized: true,
      }),
    ).toEqual({ team: "Goat", assignee: null, priority: 0 });
  });

  it("rejects contradictory explicit filters", () => {
    expect(() => normalizeLinearListIssuesInput({ assignee: "me", unassigned: true })).toThrow(
      "Choose either an assignee or unassigned issues",
    );
    expect(() => normalizeLinearListIssuesInput({ priority: 2, unprioritized: true })).toThrow(
      "Choose either a priority or unprioritized issues",
    );
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
