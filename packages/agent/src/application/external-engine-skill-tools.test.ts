import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it, vi } from "vitest";
import { registerExternalEngineSkillTools } from "./external-engine-skill-tools";

it("does not collapse Skill edits from stateless clients with matching request ids", async () => {
  type Callback = (args: Record<string, unknown>, extra: { requestId: number }) => Promise<unknown>;
  const callbacks = new Map<string, Callback>();
  const server = {
    registerTool: (name: string, _config: unknown, callback: Callback) =>
      callbacks.set(name, callback),
  } as unknown as McpServer;
  const execute = vi.fn<Parameters<typeof registerExternalEngineSkillTools>[1]>(async () => ({}));
  registerExternalEngineSkillTools(server, execute);
  const edit = callbacks.get("edit_workspace_skill");
  if (!edit) throw new Error("Skill editor was not registered.");
  await edit({ name: "review", instructions: "First" }, { requestId: 2 });
  await edit({ name: "review", instructions: "Second" }, { requestId: 2 });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]?.[0]).not.toMatchObject({
    invocationId: execute.mock.calls[1]?.[0].invocationId,
  });
});
