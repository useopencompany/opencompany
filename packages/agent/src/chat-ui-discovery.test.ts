import { describe, expect, it } from "vitest";
import { type ChatUiMessage, listedActionSourceIdsFromMessages } from "./chat-ui";

describe("action discovery history", () => {
  it("recognizes legacy and compact listings plus descriptions without rewriting history", () => {
    const messages = [
      {
        id: "history",
        role: "assistant",
        parts: [
          {
            type: "tool-list_actions",
            state: "output-available",
            toolCallId: "legacy",
            input: { source: "gmail" },
            output: {
              ok: true,
              source: { id: "gmail", label: "Gmail", description: "Email" },
              actions: [
                {
                  id: "gmail.search",
                  source: "gmail",
                  description: "Search",
                  params: { type: "object" },
                  permissionMode: "on",
                },
              ],
            },
          },
          {
            type: "tool-list_actions",
            state: "output-available",
            toolCallId: "compact",
            input: { source: "linkedin" },
            output: {
              ok: true,
              source: { id: "linkedin", label: "LinkedIn", description: "People" },
              actions: [],
            },
          },
          {
            type: "tool-describe_actions",
            state: "output-available",
            toolCallId: "describe",
            input: { actions: ["posthog.read", "gmail.search"] },
            output: {
              ok: true,
              actions: [
                {
                  id: "posthog.read",
                  source: "posthog",
                  description: "Read",
                  params: {},
                  permissionMode: "on",
                },
                {
                  id: "gmail.search",
                  source: "gmail",
                  description: "Search",
                  params: {},
                  permissionMode: "on",
                },
              ],
              not_found: ["missing"],
            },
          },
          {
            type: "tool-describe_actions",
            state: "output-available",
            toolCallId: "failed",
            input: { actions: [] },
            output: { ok: false, error: { code: "invalid_params", message: "Invalid" } },
          },
        ],
      },
    ] satisfies ChatUiMessage[];
    const before = JSON.stringify(messages);
    expect(listedActionSourceIdsFromMessages(messages)).toEqual(["gmail", "linkedin", "posthog"]);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
