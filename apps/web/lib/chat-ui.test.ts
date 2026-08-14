import type { ChatMessageDebugTrace } from "@opencompany/db/product-schema";
import { describe, expect, it } from "vitest";
import {
  CODEX_COMMAND_TOOL_PART_TYPE,
  chatSummaryState,
  compareChatMessageOrder,
  deriveChatState,
  LIST_ACTIONS_TOOL_PART_TYPE,
  LIST_SKILLS_TOOL_PART_TYPE,
  listedActionSourceIdsFromMessages,
  listedSkillIdsFromMessages,
  nextChatMessageCreatedAt,
  START_TASK_TOOL_PART_TYPE,
  type StoredChatMessage,
  toChatUiMessage,
  USE_SKILL_TOOL_PART_TYPE,
  usedSkillIdsFromMessages,
} from "@/lib/chat-ui";
import { DEFAULT_MODEL } from "@/lib/model-options";

describe("chatSummaryState", () => {
  it("shows active agent runtime as working before unread", () => {
    expect(
      chatSummaryState({
        codexRuntime: {
          status: "running",
          error: null,
          updatedAt: "2026-08-02T20:59:00.000Z",
        },
        lastSeenAt: "2026-08-02T20:55:00.000Z",
        state: "done_unseen",
        updatedAt: "2026-08-02T21:00:00.000Z",
      }),
    ).toBe("working");
  });

  it("marks completed newer agent work as unseen after runtime stops", () => {
    expect(
      deriveChatState({
        codexRuntime: { status: "idle" },
        lastSeenAt: "2026-08-02T20:55:00.000Z",
        updatedAt: "2026-08-02T21:00:00.000Z",
      }),
    ).toBe("done_unseen");
  });

  it("shows a runtime with an active turn as working even if status lags", () => {
    expect(
      chatSummaryState({
        codexRuntime: {
          status: "idle",
          activeTurnId: "goat_codex_chat_turn_1",
          error: null,
          updatedAt: "2026-08-02T20:59:00.000Z",
        },
        lastSeenAt: "2026-08-02T20:55:00.000Z",
        state: "done_unseen",
        updatedAt: "2026-08-02T21:00:00.000Z",
      }),
    ).toBe("working");
  });
});

describe("toChatUiMessage", () => {
  it("surfaces scheduled wakeup debug metadata on its synthetic user message", () => {
    const message = storedAssistantMessage({
      role: "user",
      content: "Scheduled check-in: Wait for CI",
      debugTrace: {
        scheduledWakeup: {
          reason: "Wait for CI",
          dueAt: "2026-07-10T09:02:00.000Z",
        },
      },
    });

    expect(toChatUiMessage(message).metadata?.scheduledWakeup).toEqual({
      reason: "Wait for CI",
      dueAt: "2026-07-10T09:02:00.000Z",
    });
  });

  it("replays persisted UI message parts in their original order", () => {
    const message = storedAssistantMessage({
      content: "Before.After",
      debugTrace: {
        schemaVersion: "opencompany.chat.debug.v1",
        model: DEFAULT_MODEL,
        uiMessageParts: [
          { type: "text", text: "Before." },
          {
            type: START_TASK_TOOL_PART_TYPE,
            toolCallId: "tool_1",
            state: "output-available",
            input: {
              prompt: "Research the market",
              name: "Research market",
            },
            output: {
              taskId: "task_1",
              taskDisplayId: "TASK-42",
              taskName: "Research market",
              status: "queued",
              prompt: "Research the market",
            },
          },
          { type: "text", text: "After." },
        ],
      },
    });

    expect(toChatUiMessage(message).parts.map((part) => part.type)).toEqual([
      "text",
      START_TASK_TOOL_PART_TYPE,
      "text",
    ]);
  });

  it("rehydrates safe generated-file parts without private storage metadata", () => {
    const message = storedAssistantMessage({
      content: "Here is the plan.",
      debugTrace: {
        uiMessageParts: [
          { type: "text", text: "Here is the plan." },
          {
            type: "data-artifact-file",
            data: {
              artifactId: "artifact_1",
              artifactVersionId: "version_1",
              version: 1,
              title: "Launch plan",
              filename: "launch-plan.md",
              mediaType: "text/markdown",
              sizeBytes: 42,
              state: "ready",
              blobPathname: "private/should-not-survive",
            },
          },
        ],
      },
    });

    expect(toChatUiMessage(message).parts).toEqual([
      { type: "text", text: "Here is the plan." },
      {
        type: "data-artifact-file",
        data: {
          artifactId: "artifact_1",
          artifactVersionId: "version_1",
          version: 1,
          title: "Launch plan",
          filename: "launch-plan.md",
          mediaType: "text/markdown",
          sizeBytes: 42,
          state: "ready",
        },
      },
    ]);
  });

  it.each([
    "Tasks",
    "Results",
  ])("places legacy task cards before the Added to %s continuation", (destination) => {
    const message = storedAssistantMessage({
      content: `This needs live Linear access, so I'm spinning up a task to pull the opencompany team's current issues and give you a prioritized "what's next" recommendation.Added to ${destination} as TASK-26. It'll pull the opencompany team's Linear board.`,
      taskId: "task_26",
      taskDisplayId: "TASK-26",
      taskName: "Linear opencompany team status + next steps",
      taskPrompt: "Pull the opencompany team's Linear board and recommend what to work on next.",
      debugTrace: {
        schemaVersion: "opencompany.chat.debug.v1",
        model: DEFAULT_MODEL,
        toolResults: [
          {
            taskId: "task_26",
            taskDisplayId: "TASK-26",
            taskName: "Linear opencompany team status + next steps",
            status: "queued",
            prompt: "Pull the opencompany team's Linear board and recommend what to work on next.",
          },
        ],
      },
    });

    const parts = toChatUiMessage(message).parts;

    expect(parts.map((part) => part.type)).toEqual(["text", START_TASK_TOOL_PART_TYPE, "text"]);
    expect(parts[0]).toEqual({
      type: "text",
      text: "This needs live Linear access, so I'm spinning up a task to pull the opencompany team's current issues and give you a prioritized \"what's next\" recommendation.",
    });
    expect(parts[2]).toEqual({
      type: "text",
      text: `Added to ${destination} as TASK-26. It'll pull the opencompany team's Linear board.`,
    });
  });

  it("replays persisted codex turns with reasoning and command parts", () => {
    const message = storedAssistantMessage({
      content: "The repo has three apps.",
      debugTrace: {
        schemaVersion: "goat.codex_chat.debug.v1",
        model: "gpt-5.5",
        uiMessageParts: [
          { type: "reasoning", text: "Scanning the repository layout." },
          {
            type: CODEX_COMMAND_TOOL_PART_TYPE,
            toolCallId: "cmd_1",
            state: "output-available",
            input: { command: "ls apps" },
            output: { status: "completed", exitCode: 0 },
          },
          { type: "text", text: "The repo has three apps." },
        ],
      },
    });

    const parts = toChatUiMessage(message).parts;
    expect(parts.map((part) => part.type)).toEqual([
      "reasoning",
      CODEX_COMMAND_TOOL_PART_TYPE,
      "text",
    ]);
    expect(parts[0]).toEqual({
      type: "reasoning",
      text: "Scanning the repository layout.",
      state: "done",
    });
    // Content mirror must not be re-appended: a non-empty text part already exists.
    expect(parts.filter((part) => part.type === "text")).toHaveLength(1);
  });

  it("keeps an in-flight codex command part renderable as running", () => {
    const message = storedAssistantMessage({
      content: "",
      debugTrace: {
        schemaVersion: "goat.codex_chat.debug.v1",
        model: "gpt-5.5",
        uiMessageParts: [
          {
            type: CODEX_COMMAND_TOOL_PART_TYPE,
            toolCallId: "cmd_1",
            state: "input-available",
            input: { command: "bun test" },
          },
        ],
      },
    });

    expect(toChatUiMessage(message).parts[0]).toMatchObject({
      type: CODEX_COMMAND_TOOL_PART_TYPE,
      state: "input-available",
      input: { command: "bun test" },
    });
  });

  it("preserves task id and status in message metadata", () => {
    const message = storedAssistantMessage({
      taskId: "task_1",
      taskDisplayId: "TASK-1",
      taskName: "Research market",
      taskStatus: "succeeded",
    });

    expect(toChatUiMessage(message).metadata).toMatchObject({
      sessionId: "goat_chat_1",
      taskId: "task_1",
      task: {
        id: "task_1",
        displayId: "TASK-1",
        title: "Research market",
        status: "succeeded",
      },
    });
  });

  it("exposes persisted turn timing in message metadata", () => {
    const message = storedAssistantMessage({
      debugTrace: {
        schemaVersion: "goat.codex_chat.debug.v1",
        model: "gpt-5.5",
        durationMs: 153_400,
      },
      createdAt: new Date("2026-07-04T12:00:00.000Z"),
      updatedAt: new Date("2026-07-04T12:02:33.400Z"),
    });

    expect(toChatUiMessage(message).metadata?.timing).toEqual({
      createdAt: "2026-07-04T12:00:00.000Z",
      updatedAt: "2026-07-04T12:02:33.400Z",
      durationMs: 153_400,
    });
  });

  it("exposes persisted context usage in message metadata", () => {
    const message = storedAssistantMessage({
      debugTrace: {
        schemaVersion: "opencompany.chat.debug.v1",
        model: DEFAULT_MODEL,
        usage: {
          inputTokens: 14_000,
          outputTokens: 200,
          totalTokens: 14_200,
        },
      },
    });

    expect(toChatUiMessage(message).metadata?.contextTokens).toBe(14_200);
  });
});

describe("listedActionSourceIdsFromMessages", () => {
  it("recovers successful action discovery from earlier persisted turns", () => {
    const discovered = toChatUiMessage(
      storedAssistantMessage({
        debugTrace: {
          schemaVersion: "opencompany.chat.debug.v1",
          model: DEFAULT_MODEL,
          uiMessageParts: [
            {
              type: LIST_ACTIONS_TOOL_PART_TYPE,
              toolCallId: "list_linkedin",
              state: "output-available",
              input: { source: "linkedin" },
              output: {
                ok: true,
                source: {
                  id: "linkedin",
                  kind: "managed",
                  label: "LinkedIn",
                  description: "Metered public LinkedIn research.",
                },
                actions: [],
              },
            },
          ],
        },
      }),
    );

    expect(listedActionSourceIdsFromMessages([discovered])).toEqual(["linkedin"]);
  });

  it("ignores unsuccessful discovery results", () => {
    const failed = {
      id: "assistant_failed",
      role: "assistant" as const,
      parts: [
        {
          type: LIST_ACTIONS_TOOL_PART_TYPE,
          toolCallId: "list_unknown",
          state: "output-available" as const,
          input: { source: "linkedin" as const },
          output: {
            ok: false as const,
            error: {
              code: "unknown_source" as const,
              message: "Unknown source.",
              availableSources: [],
            },
          },
        },
      ],
    };

    expect(listedActionSourceIdsFromMessages([failed])).toEqual([]);
  });
});

describe("listedSkillIdsFromMessages", () => {
  it("recovers the exact skills returned by successful discovery", () => {
    const discovered = toChatUiMessage(
      storedAssistantMessage({
        debugTrace: {
          schemaVersion: "opencompany.chat.debug.v1",
          model: DEFAULT_MODEL,
          uiMessageParts: [
            {
              type: LIST_SKILLS_TOOL_PART_TYPE,
              toolCallId: "list_skills_1",
              state: "output-available",
              input: { query: "product" },
              output: {
                ok: true,
                skills: [
                  {
                    id: "product-feature",
                    name: "Product feature",
                    description: "Build and verify product changes.",
                  },
                ],
                total: 1,
                truncated: false,
              },
            },
          ],
        },
      }),
    );

    expect(listedSkillIdsFromMessages([discovered])).toEqual(["product-feature"]);
  });

  it("ignores skill discovery that did not produce an available output", () => {
    const running = {
      id: "assistant_running",
      role: "assistant" as const,
      parts: [
        {
          type: LIST_SKILLS_TOOL_PART_TYPE,
          toolCallId: "list_skills_1",
          state: "input-available" as const,
          input: { query: "product" },
        },
      ],
    };

    expect(listedSkillIdsFromMessages([running])).toEqual([]);
  });
});

describe("usedSkillIdsFromMessages", () => {
  it("recovers skills whose instructions were loaded successfully", () => {
    const loaded = toChatUiMessage(
      storedAssistantMessage({
        debugTrace: {
          schemaVersion: "opencompany.chat.debug.v1",
          model: DEFAULT_MODEL,
          uiMessageParts: [
            {
              type: USE_SKILL_TOOL_PART_TYPE,
              toolCallId: "use_skill_1",
              state: "output-available",
              input: { skill: "product-feature" },
              output: {
                ok: true,
                skill: {
                  id: "product-feature",
                  name: "Product feature",
                  description: "Build and verify product changes.",
                  instructions: "Inspect, implement, and verify.",
                },
              },
            },
          ],
        },
      }),
    );

    expect(usedSkillIdsFromMessages([loaded])).toEqual(["product-feature"]);
  });
});

describe("compareChatMessageOrder", () => {
  it("keeps equal-timestamp Codex turn placeholders in user-then-assistant order", () => {
    const createdAt = "2026-07-10T08:00:00.000Z";
    const messages = [
      { id: "assistant_1", role: "assistant" as const, createdAt },
      { id: "user_1", role: "user" as const, createdAt },
    ];

    expect(messages.toSorted(compareChatMessageOrder).map((message) => message.id)).toEqual([
      "user_1",
      "assistant_1",
    ]);
  });

  it("creates a strictly later timestamp for pre-created assistant placeholders", () => {
    const userCreatedAt = new Date("2026-07-10T08:00:00.000Z");

    expect(nextChatMessageCreatedAt(userCreatedAt).toISOString()).toBe("2026-07-10T08:00:00.001Z");
  });
});

function storedAssistantMessage(
  overrides: Partial<StoredChatMessage> & {
    debugTrace?: ChatMessageDebugTrace | null;
  } = {},
): StoredChatMessage {
  const now = new Date("2026-07-04T12:00:00.000Z");
  return {
    id: "goat_chat_msg_1",
    sessionId: "goat_chat_1",
    role: "assistant",
    content: "Done.",
    taskId: null,
    debugTrace: null,
    attachments: null,
    attachmentTexts: null,
    createdAt: now,
    updatedAt: now,
    taskDisplayId: null,
    taskName: null,
    taskPrompt: null,
    taskStatus: null,
    ...overrides,
  };
}
