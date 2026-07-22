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

function getTool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
  const tool = tools.get(name);
  if (!tool) throw new Error(`${name} was not registered`);
  return tool;
}

/** The toolInput passed to the shared read engine on the most recent read call. */
function lastToolInput() {
  const calls = brainCliMock.runGoatBrainToolForUser.mock.calls;
  return calls.at(-1)?.[0]?.toolInput;
}

describe("Goat MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspacesMock.listAccessibleGoatBrainsForUser.mockResolvedValue([general]);
    workspacesMock.getGoatBrainAccess.mockResolvedValue({
      brain: general.brain,
      workspaceRole: "admin",
    });
    brainCliMock.runGoatBrainToolForUser.mockResolvedValue({
      ok: true,
      brainRef: general.brain.id,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      parsed: { hits: [] },
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

  it("registers the flat retrieval surface plus capture and the advanced escape hatch", () => {
    const tools = registerTools();
    expect([...tools.keys()].sort()).toEqual(
      [
        "get_document",
        "get_timeline",
        "goat_brain",
        "list_brains",
        "list_documents",
        "save_to_brain",
        "search_brain",
      ].sort(),
    );
  });

  it("marks every retrieval tool read-only and capture as a non-destructive write", () => {
    const tools = registerTools();
    for (const name of [
      "search_brain",
      "get_document",
      "list_documents",
      "get_timeline",
      "goat_brain",
      "list_brains",
    ]) {
      expect(getTool(tools, name).config.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
      });
    }
    expect(getTool(tools, "save_to_brain").config.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
    });
    expect(getTool(tools, "list_brains").config.outputSchema).toBeDefined();
    expect(getTool(tools, "save_to_brain").config.outputSchema).toBeDefined();
  });

  it("search_brain maps a flat query into the engine's query command", async () => {
    const tools = registerTools();
    const result = await getTool(tools, "search_brain").callback({ query: "workos sponsorship" });

    expect(brainCliMock.runGoatBrainToolForUser).toHaveBeenCalledTimes(1);
    expect(brainCliMock.runGoatBrainToolForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        brainRef: general.brain.id,
        userWorkosId: "user_123",
        sourceRef: `mcp:${general.brain.id}`,
        toolInput: {
          command: "query",
          flags: { text: "workos sponsorship", limit: 10, includeNeighbors: false, json: true },
        },
      }),
    );
    expect(result.isError).toBe(false);
  });

  it("get_document accepts a single scalar id (the shape agents reach for first)", async () => {
    const tools = registerTools();
    await getTool(tools, "get_document").callback({ id: "youtube-series-sponsorship-program" });

    expect(lastToolInput()).toEqual({
      command: "get",
      flags: { id: ["youtube-series-sponsorship-program"], json: true },
    });
  });

  it("get_document accepts an array of ids", async () => {
    const tools = registerTools();
    await getTool(tools, "get_document").callback({ ids: ["a", "b"] });

    expect(lastToolInput()).toEqual({
      command: "get",
      flags: { id: ["a", "b"], json: true },
    });
  });

  it("get_document errors clearly when no id is provided, without hitting the engine", async () => {
    const tools = registerTools();
    const result = await getTool(tools, "get_document").callback({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("needs at least one id");
    expect(brainCliMock.runGoatBrainToolForUser).not.toHaveBeenCalled();
  });

  it("list_documents and get_timeline map to their commands", async () => {
    const tools = registerTools();

    await getTool(tools, "list_documents").callback({ folder: "people", kind: "page" });
    expect(lastToolInput()).toEqual({
      command: "list",
      flags: { folder: "people", kind: "page", json: true },
    });

    await getTool(tools, "get_timeline").callback({ id: "workos-sponsorship", since: "2d" });
    expect(lastToolInput()).toEqual({
      command: "timeline",
      flags: { id: "workos-sponsorship", since: "2d", json: true },
    });
  });

  it("goat_brain still accepts the raw command/flags shape", async () => {
    const tools = registerTools();
    await getTool(tools, "goat_brain").callback({ command: "doctor" });

    expect(lastToolInput()).toEqual({ command: "doctor" });
  });

  it("resolves the brain from the brain_id alias", async () => {
    const research = {
      brain: { id: "research-cccccccccccc", slug: "research", name: "Research", description: null },
      workspace: general.workspace,
      workspaceRole: "admin",
    } as GoatBrainWithWorkspace;
    workspacesMock.listAccessibleGoatBrainsForUser.mockResolvedValue([general, research]);

    const tools = registerTools();
    await getTool(tools, "search_brain").callback({
      query: "roadmap",
      brain_id: "research-cccccccccccc",
    });

    expect(brainCliMock.runGoatBrainToolForUser).toHaveBeenCalledWith(
      expect.objectContaining({ brainRef: "research-cccccccccccc" }),
    );
  });

  it("surfaces the multi-brain disambiguation error when no brain is given", async () => {
    const research = {
      brain: { id: "research-cccccccccccc", slug: "research", name: "Research", description: null },
      workspace: general.workspace,
      workspaceRole: "admin",
    } as GoatBrainWithWorkspace;
    workspacesMock.listAccessibleGoatBrainsForUser.mockResolvedValue([general, research]);

    const tools = registerTools();
    const result = await getTool(tools, "search_brain").callback({ query: "roadmap" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(general.brain.id);
    expect(result.content[0]?.text).toContain("research-cccccccccccc");
    expect(brainCliMock.runGoatBrainToolForUser).not.toHaveBeenCalled();
  });

  it("captures explicit content into the selected brain and returns structured status", async () => {
    const tools = registerTools();
    const result = await getTool(tools, "save_to_brain").callback({
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

  it("resolves save_to_brain's brain from the brain_id alias too", async () => {
    const tools = registerTools();
    await getTool(tools, "save_to_brain").callback({
      brain_id: general.brain.id,
      content: "Remember this.",
    });

    expect(captureMock.captureToGoatBrainInbox).toHaveBeenCalledWith(
      expect.objectContaining({ brainRef: general.brain.id }),
    );
  });

  it("keeps the existing workspace-admin write boundary", async () => {
    workspacesMock.getGoatBrainAccess.mockResolvedValue({
      brain: general.brain,
      workspaceRole: "member",
    });
    const tools = registerTools();
    const result = await getTool(tools, "save_to_brain").callback({ content: "Remember this." });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toContain("Only workspace admins");
    expect(captureMock.captureToGoatBrainInbox).not.toHaveBeenCalled();
  });

  it("reports save capability when listing brains", async () => {
    const tools = registerTools();
    const result = await getTool(tools, "list_brains").callback();
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload.workspaces[0].brains[0]).toMatchObject({
      id: general.brain.id,
      canSave: true,
    });
    expect(result.structuredContent).toEqual(payload);
  });
});
