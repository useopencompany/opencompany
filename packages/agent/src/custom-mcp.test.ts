import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), close: vi.fn() }));
vi.mock("@ai-sdk/mcp", () => ({ createMCPClient: mocks.create }));

import {
  createCustomMcpPackage,
  customMcpError,
  probeCustomMcp,
  redactCustomMcpValue,
} from "./custom-mcp";

const endpoint = "https://tools.example.com/mcp";
const canary = "synthetic-credential-canary";
const tool = {
  name: "send_message",
  description: "Send a message",
  inputSchema: { type: "object", properties: { body: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockResolvedValue({ listTools: mocks.list, close: mocks.close });
  mocks.close.mockResolvedValue(undefined);
});

it("discovers paginated tools with conservative Ask defaults and no SDK retries or OAuth", async () => {
  mocks.list
    .mockResolvedValueOnce({ tools: [tool], nextCursor: "page-2" })
    .mockResolvedValueOnce({ tools: [{ ...tool, name: "read_message" }] });
  const probe = await probeCustomMcp(endpoint, { headers: { Authorization: `Bearer ${canary}` } });
  expect(probe.tools).toHaveLength(2);
  expect(
    probe.tools.every(
      (entry) => entry.classification.defaultMode === "ask" && !entry.classification.curated,
    ),
  ).toBe(true);
  expect(mocks.list.mock.calls[1]?.[0].params).toEqual({ cursor: "page-2" });
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      maxRetries: 0,
      transport: { type: "http", url: endpoint, fetch: expect.any(Function) },
    }),
  );
  expect(JSON.stringify(mocks.create.mock.calls)).not.toContain(canary);
  expect(mocks.close).toHaveBeenCalledOnce();
});

it.each([
  [{ tools: [tool, tool] }],
  [{ tools: [{ ...tool, inputSchema: { type: "string" } }] }],
  [
    { tools: [tool], nextCursor: "repeat" },
    { tools: [], nextCursor: "repeat" },
  ],
  [{ tools: [{ ...tool, name: "bad tool name" }] }],
])("rejects invalid discovery and closes the client", async (...pages) => {
  for (const page of pages as unknown as object[]) mocks.list.mockResolvedValueOnce(page);
  await expect(probeCustomMcp(endpoint, { headers: {} })).rejects.toThrow("invalid or oversized");
  expect(mocks.close).toHaveBeenCalledOnce();
});

it("accepts a zero-tool server and redacts credentials from discovery and nested result keys", async () => {
  mocks.list.mockResolvedValueOnce({ tools: [] });
  expect((await probeCustomMcp(endpoint, { headers: {} })).tools).toEqual([]);
  const redacted = redactCustomMcpValue(
    { [canary]: [{ text: `Bearer ${canary}` }] },
    { Authorization: `Bearer ${canary}` },
  );
  expect(JSON.stringify(redacted)).not.toContain(canary);
  expect(customMcpError(new Error(`Unauthorized: ${canary}`))).not.toContain(canary);
  expect(customMcpError(new Error(`Unexpected server error ${canary}`))).not.toContain(canary);
});

it("stores a standard plugin package with no executable, credentials, or fake git revision", async () => {
  const plugin = await createCustomMcpPackage(
    { label: "Company tools", url: endpoint },
    "custom-123",
  );
  expect(plugin.source).toEqual({
    type: "custom_mcp",
    url: endpoint,
    ref: "",
    path: "",
    resolvedCommit: "",
  });
  expect(plugin.remoteServers).toEqual([
    { name: "mcp", type: "streamable-http", url: endpoint, headers: {} },
  ]);
  expect(plugin.stdioServers).toEqual([]);
  expect(plugin.skills).toEqual([]);
  expect(plugin.files.every((file) => !file.executable)).toBe(true);
});
