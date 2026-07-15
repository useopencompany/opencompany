import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GoatBrainWithWorkspace } from "@opencompany/db/goat-workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workspacesMock = vi.hoisted(() => ({
  listAccessibleGoatBrainsForUser: vi.fn(),
  getGoatBrainAccess: vi.fn(),
}));
const brainCliMock = vi.hoisted(() => ({
  runGoatBrainToolForUser: vi.fn(),
}));
const captureMock = vi.hoisted(() => ({
  captureToGoatBrainInbox: vi.fn(),
}));

vi.mock("@opencompany/db/goat-workspaces", () => workspacesMock);
vi.mock("@/lib/brain-cli", () => brainCliMock);
vi.mock("@/lib/brain-capture", () => captureMock);

import { registerGoatBrainTools } from "./mcp-server";

type RegisteredTool = {
  config: Record<string, unknown>;
  callback: (...args: unknown[]) => Promise<{
    content: Array<{ text?: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
};

const general = {
  brain: {
    id: "general-aaaaaaaaaaaa",
    slug: "general",
    name: "General",
    description: null,
  },
  workspace: {
    id: "goat_ws_acme",
    name: "Acme",
    workosOrganizationId: null,
  },
  workspaceRole: "admin",
} as GoatBrainWithWorkspace;

function registerTools() {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: vi.fn(
      (name: string, config: Record<string, unknown>, callback: RegisteredTool["callback"]) => {
        tools.set(name, { config, callback });
      },
    ),
  } as unknown as McpServer;
  registerGoatBrainTools(server, {
    userWorkosId: "user_123",
    gatewayApiKey: "gateway_test",
  });
  return tools;
}

describe("Goat MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspacesMock.listAccessibleGoatBrainsForUser.mockResolvedValue([general]);
    workspacesMock.getGoatBrainAccess.mockResolvedValue({
      brain: general.brain,
      workspaceRole: "admin",
    });
    captureMock.captureToGoatBrainInbox.mockResolvedValue({
      ok: true,
      draftBrainId: "pricing-idea",
      path: "inbox/pricing-idea.md",
      title: "Pricing idea",
      jobId: "job_123",
      enqueued: true,
    });
  });

  it("marks retrieval tools read-only and capture as a non-destructive write", () => {
    const tools = registerTools();

    expect(tools.get("goat_brain")?.config.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
    });
    expect(tools.get("save_to_brain")?.config.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
    });
    expect(tools.get("list_brains")?.config.outputSchema).toBeDefined();
    expect(tools.get("save_to_brain")?.config.outputSchema).toBeDefined();
  });

  it("captures explicit content into the selected brain and returns structured status", async () => {
    const tools = registerTools();
    const save = tools.get("save_to_brain");
    if (!save) throw new Error("save_to_brain was not registered");

    const result = await save.callback({
      brain: general.brain.id,
      content: "Keep usage-based pricing simple for small teams.",
      title: "Pricing idea",
      intent: "Product principle",
    });

    expect(captureMock.captureToGoatBrainInbox).toHaveBeenCalledWith({
      brainRef: general.brain.id,
      userWorkosId: "user_123",
      text: "Keep usage-based pricing simple for small teams.",
      title: "Pricing idea",
      intent: "Product principle",
      source: {
        kind: "mcp",
        connectionId: `mcp:${general.brain.id}`,
        itemId: expect.stringMatching(/^capture_[0-9a-f-]{36}$/),
      },
    });
    expect(result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        status: "captured",
        brainId: general.brain.id,
        draftId: "pricing-idea",
        path: "inbox/pricing-idea.md",
        curation: "queued",
      },
    });
  });

  it("keeps the existing workspace-admin write boundary", async () => {
    workspacesMock.getGoatBrainAccess.mockResolvedValue({
      brain: general.brain,
      workspaceRole: "member",
    });
    const tools = registerTools();
    const save = tools.get("save_to_brain");
    if (!save) throw new Error("save_to_brain was not registered");

    const result = await save.callback({ content: "Remember this." });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toContain("Only workspace admins");
    expect(captureMock.captureToGoatBrainInbox).not.toHaveBeenCalled();
  });

  it("reports save capability when listing brains", async () => {
    const tools = registerTools();
    const list = tools.get("list_brains");
    if (!list) throw new Error("list_brains was not registered");

    const result = await list.callback();
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload.workspaces[0].brains[0]).toMatchObject({
      id: general.brain.id,
      canSave: true,
    });
    expect(result.structuredContent).toEqual(payload);
  });
});
