import { getGoatWorkspaceRole } from "@opencompany/db/goat-workspaces";
import { slackApiRequest } from "@opencompany/goat-agent/integrations/slack";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGoatSlackSenderCacheForTests,
  resolveGoatSlackSender,
} from "./goat-slack-bot-identity";

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

vi.mock("@opencompany/db/goat-workspaces", () => ({
  getGoatWorkspaceRole: vi.fn(async () => null),
}));

vi.mock("@opencompany/goat-agent/integrations/slack", () => ({
  slackApiRequest: vi.fn(),
}));

const GOAT_USER = {
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

describe("resolveGoatSlackSender", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGoatSlackSenderCacheForTests();
    dbState.rows = [GOAT_USER];
    vi.mocked(slackApiRequest).mockResolvedValue({
      ok: true,
      user: { is_bot: false, profile: { email: "Jane@Acme.com" } },
    });
    vi.mocked(getGoatWorkspaceRole).mockResolvedValue("member");
  });

  it("maps a Slack sender to the goat workspace member by email, case-insensitively", async () => {
    const resolution = await resolveGoatSlackSender(INPUT);
    expect(resolution).toEqual({
      kind: "member",
      member: { ...GOAT_USER, role: "member" },
    });
  });

  it("caches resolutions per team/workspace/user until the TTL expires", async () => {
    let nowValue = 0;
    const now = () => nowValue;
    await resolveGoatSlackSender({ ...INPUT, now });
    await resolveGoatSlackSender({ ...INPUT, now });
    expect(slackApiRequest).toHaveBeenCalledTimes(1);

    nowValue = 11 * 60 * 1000;
    await resolveGoatSlackSender({ ...INPUT, now });
    expect(slackApiRequest).toHaveBeenCalledTimes(2);
  });

  it("treats bots, missing emails, and ambiguous matches as unmapped", async () => {
    vi.mocked(slackApiRequest).mockResolvedValueOnce({ ok: true, user: { is_bot: true } });
    expect(await resolveGoatSlackSender(INPUT)).toEqual({ kind: "unmapped", reason: "bot" });

    clearGoatSlackSenderCacheForTests();
    vi.mocked(slackApiRequest).mockResolvedValueOnce({ ok: true, user: { profile: {} } });
    expect(await resolveGoatSlackSender(INPUT)).toEqual({ kind: "unmapped", reason: "no_email" });

    clearGoatSlackSenderCacheForTests();
    dbState.rows = [GOAT_USER, { ...GOAT_USER, workosUserId: "user_2" }];
    expect(await resolveGoatSlackSender(INPUT)).toEqual({ kind: "unmapped", reason: "no_match" });

    clearGoatSlackSenderCacheForTests();
    dbState.rows = [];
    expect(await resolveGoatSlackSender(INPUT)).toEqual({ kind: "unmapped", reason: "no_match" });
  });

  it("treats goat users outside the installing workspace as unmapped", async () => {
    vi.mocked(getGoatWorkspaceRole).mockResolvedValue(null);
    expect(await resolveGoatSlackSender(INPUT)).toEqual({
      kind: "unmapped",
      reason: "not_in_workspace",
    });
  });

  it("does not cache transient lookup failures", async () => {
    vi.mocked(slackApiRequest).mockRejectedValueOnce(new Error("ratelimited"));
    expect(await resolveGoatSlackSender(INPUT)).toEqual({
      kind: "unmapped",
      reason: "lookup_failed",
    });

    // The next call retries Slack instead of serving the failure from cache.
    expect(await resolveGoatSlackSender(INPUT)).toEqual({
      kind: "member",
      member: { ...GOAT_USER, role: "member" },
    });
    expect(slackApiRequest).toHaveBeenCalledTimes(2);
  });
});
