import { describe, expect, it, vi } from "vitest";
import { runSlackWikiCommand } from "./slack-bot-answer";

const commandInput = {
  origin: "http://api.local",
  token: "internal-token",
  workspaceId: "workspace_1",
  actorId: "user_1",
  idempotencyKey: "slack-wiki:request_1",
};

describe("runSlackWikiCommand", () => {
  it.each([
    { command: "tree" as const, depth: 1 },
    { command: "read" as const, pages: ["projects/atlas"] },
    { command: "search" as const, query: "renewal", limit: 5, offset: 10 },
  ])("routes the $command command through the canonical Wiki API", async (toolInput) => {
    const execute = vi.fn(async () => ({ ok: true as const, result: [] }));

    await expect(runSlackWikiCommand({ ...commandInput, toolInput }, execute)).resolves.toEqual({
      ok: true,
      result: [],
    });
    expect(execute).toHaveBeenCalledWith({ ...commandInput, toolInput });
  });

  it("routes Wiki writes through the same authorized API boundary", async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { action: "created" } }));

    await expect(
      runSlackWikiCommand(
        {
          ...commandInput,
          toolInput: { command: "write", path: "customers/acme", body: "# Acme" },
        },
        execute,
      ),
    ).resolves.toEqual({ ok: true, result: { action: "created" } });
    expect(execute).toHaveBeenCalledWith({
      ...commandInput,
      toolInput: { command: "write", path: "customers/acme", body: "# Acme" },
    });
  });

  it("returns API transport failures as tool errors", async () => {
    const execute = vi.fn(async () => {
      throw new Error("Wiki API unavailable");
    });

    await expect(
      runSlackWikiCommand({ ...commandInput, toolInput: { command: "tree" } }, execute),
    ).resolves.toEqual({ ok: false, error: "Wiki API unavailable" });
  });
});
