import { describe, expect, it, vi } from "vitest";
import {
  listGoatSlackConversationOptions,
  type SlackApiRequester,
} from "@/lib/integrations/slack-conversations";

describe("listGoatSlackConversationOptions", () => {
  it("keeps Slack Connect channels and one-to-one DMs visible", async () => {
    const request = vi.fn(async ({ method, form }: Parameters<SlackApiRequester>[0]) => {
      if (method === "users.conversations") {
        return {
          channels: [
            { id: "C_LOCAL", name: "general" },
            {
              id: "C_CONNECT",
              name: "acme-partner",
              is_private: true,
              is_ext_shared: true,
            },
            { id: "D_LOCAL", is_im: true, user: "U_LOCAL" },
            { id: "D_CONNECT", is_im: true, user: "U_CONNECT" },
            // Some limited Slack Connect IM objects omit `user`. Resolve the
            // counterpart through conversation membership instead of dropping it.
            { id: "D_CONNECT_LIMITED", is_im: true, is_ext_shared: true },
          ],
        };
      }
      if (method === "conversations.members") {
        expect(form?.channel).toBe("D_CONNECT_LIMITED");
        return { members: ["U_SELF", "U_LIMITED"] };
      }
      if (method === "users.info") {
        const users = {
          U_LOCAL: {
            id: "U_LOCAL",
            team_id: "T_HOME",
            profile: { display_name: "Local teammate" },
          },
          U_CONNECT: {
            id: "U_CONNECT",
            team_id: "T_PARTNER",
            real_name: "External Partner",
          },
          U_LIMITED: {
            id: "U_LIMITED",
            team_id: "T_OTHER",
            name: "limited-partner",
          },
        };
        return { user: users[form?.user as keyof typeof users] };
      }
      throw new Error(`Unexpected Slack method: ${method}`);
    }) as unknown as SlackApiRequester;

    const result = await listGoatSlackConversationOptions({
      token: "xoxp-test",
      teamId: "T_HOME",
      authedUserId: "U_SELF",
      request,
    });

    expect(result).toEqual({
      channels: [
        {
          id: "C_CONNECT",
          name: "acme-partner",
          isPrivate: true,
          isSlackConnect: true,
        },
        {
          id: "C_LOCAL",
          name: "general",
          isPrivate: false,
          isSlackConnect: false,
        },
      ],
      dms: [
        { id: "D_CONNECT", name: "External Partner", isSlackConnect: true },
        {
          id: "D_CONNECT_LIMITED",
          name: "limited-partner",
          isSlackConnect: true,
        },
        { id: "D_LOCAL", name: "Local teammate", isSlackConnect: false },
      ],
      partial: false,
    });
  });

  it("returns a selectable fallback when Slack cannot resolve DM metadata", async () => {
    const request = vi.fn(async ({ method }: Parameters<SlackApiRequester>[0]) => {
      if (method === "users.conversations") {
        return {
          channels: [
            {
              id: "D_CONNECT",
              name: "partner-conversation",
              user: "U_CONNECT",
              is_im: true,
              is_ext_shared: true,
            },
          ],
        };
      }
      throw new Error("Slack profile lookup failed");
    }) as unknown as SlackApiRequester;

    const result = await listGoatSlackConversationOptions({
      token: "xoxp-test",
      teamId: "T_HOME",
      authedUserId: "U_SELF",
      request,
    });

    expect(result.dms).toEqual([
      { id: "D_CONNECT", name: "partner-conversation", isSlackConnect: true },
    ]);
    expect(result.partial).toBe(true);
  });
});
