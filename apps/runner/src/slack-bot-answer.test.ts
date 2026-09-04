import { WIKI_READ_COMMANDS, WIKI_TOOL_COMMANDS } from "@opencompany/wiki/tool";
import { describe, expect, it, vi } from "vitest";
import { runSlackWikiCommand, slackChannelWikiAccessRefusal } from "./slack-bot-answer";

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

  it.each(WIKI_TOOL_COMMANDS.filter((command) => !WIKI_READ_COMMANDS.includes(command)))(
    "rejects the %s command before the canonical Wiki API",
    async (command) => {
      const execute = vi.fn(async () => ({ ok: true as const, result: {} }));

      await expect(
        runSlackWikiCommand({ ...commandInput, toolInput: { command } }, execute),
      ).resolves.toEqual({ ok: false, error: "I can't write to the Wiki from Slack yet." });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("returns API transport failures as tool errors", async () => {
    const execute = vi.fn(async () => {
      throw new Error("Wiki API unavailable");
    });

    await expect(
      runSlackWikiCommand({ ...commandInput, toolInput: { command: "tree" } }, execute),
    ).resolves.toEqual({ ok: false, error: "Wiki API unavailable" });
  });
});

describe("Slack channel Wiki access", () => {
  it("refuses an unmapped channel sender", () => {
    expect(slackChannelWikiAccessRefusal({ kind: "unmapped", reason: "no_match" })).toContain(
      "can't use its Wiki in this channel",
    );
  });

  it("allows a mapped workspace member", () => {
    expect(
      slackChannelWikiAccessRefusal({
        kind: "member",
        member: {
          workosUserId: "user_1",
          email: "jane@example.com",
          firstName: "Jane",
          lastName: null,
          timezone: "UTC",
          role: "member",
        },
      }),
    ).toBeNull();
  });
});
