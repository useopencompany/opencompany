import { slackApiRequest } from "@opencompany/agent/integrations/slack";
import { getWorkspaceRole } from "@opencompany/db/workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSlackSenderCacheForTests, resolveSlackSender } from "./slack-bot-identity";

const dbState = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => dbState.rows }),
      }),
    }),
  }),
}));

vi.mock("@opencompany/db/workspaces", () => ({
  getWorkspaceRole: vi.fn(async () => null),
}));

vi.mock("@opencompany/agent/integrations/slack", () => ({
  slackApiRequest: vi.fn(),
}));

const USER = {
  workosUserId: "user_1",
  email: "jane@acme.example",
  firstName: "Jane",
  lastName: "Doe",
  timezone: "Europe/Berlin",
};

const INPUT = {
  botToken: "xoxb-token",
  teamId: "T1",
  slackUserId: "U1",
  workspaceId: "ws_1",
};

describe("resolveSlackSender", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSlackSenderCacheForTests();
    dbState.rows = [USER];
    vi.mocked(slackApiRequest).mockResolvedValue({
      ok: true,
      user: { is_bot: false, profile: { email: "Jane@Acme.com" } },
    });
    vi.mocked(getWorkspaceRole).mockResolvedValue("member");
  });

  it("maps a Slack sender to the opencompany workspace member by email, case-insensitively", async () => {
    const resolution = await resolveSlackSender(INPUT);
    expect(resolution).toEqual({
      kind: "member",
      member: { ...USER, role: "member" },
    });
  });

  it("caches resolutions per team/workspace/user until the TTL expires", async () => {
    let nowValue = 0;
    const now = () => nowValue;
    await resolveSlackSender({ ...INPUT, now });
    await resolveSlackSender({ ...INPUT, now });
    expect(slackApiRequest).toHaveBeenCalledTimes(1);

    nowValue = 11 * 60 * 1000;
    await resolveSlackSender({ ...INPUT, now });
    expect(slackApiRequest).toHaveBeenCalledTimes(2);
  });

  it("treats bots, missing emails, and ambiguous matches as unmapped", async () => {
    vi.mocked(slackApiRequest).mockResolvedValueOnce({ ok: true, user: { is_bot: true } });
    expect(await resolveSlackSender(INPUT)).toEqual({ kind: "unmapped", reason: "bot" });

    clearSlackSenderCacheForTests();
    vi.mocked(slackApiRequest).mockResolvedValueOnce({ ok: true, user: { profile: {} } });
    expect(await resolveSlackSender(INPUT)).toEqual({ kind: "unmapped", reason: "no_email" });

    clearSlackSenderCacheForTests();
    dbState.rows = [USER, { ...USER, workosUserId: "user_2" }];
    expect(await resolveSlackSender(INPUT)).toEqual({ kind: "unmapped", reason: "no_match" });

    clearSlackSenderCacheForTests();
    dbState.rows = [];
    expect(await resolveSlackSender(INPUT)).toEqual({ kind: "unmapped", reason: "no_match" });
  });

  it("treats opencompany users outside the installing workspace as unmapped", async () => {
    vi.mocked(getWorkspaceRole).mockResolvedValue(null);
    expect(await resolveSlackSender(INPUT)).toEqual({
      kind: "unmapped",
      reason: "not_in_workspace",
    });
  });

  it("does not cache transient lookup failures", async () => {
    vi.mocked(slackApiRequest).mockRejectedValueOnce(new Error("ratelimited"));
    expect(await resolveSlackSender(INPUT)).toEqual({
      kind: "unmapped",
      reason: "lookup_failed",
    });

    // The next call retries Slack instead of serving the failure from cache.
    expect(await resolveSlackSender(INPUT)).toEqual({
      kind: "member",
      member: { ...USER, role: "member" },
    });
    expect(slackApiRequest).toHaveBeenCalledTimes(2);
  });
});
