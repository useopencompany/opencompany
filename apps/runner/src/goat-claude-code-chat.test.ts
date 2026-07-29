import { describe, expect, it } from "vitest";
import { extractClaudeScheduleWakeup } from "./goat-claude-code-chat";

describe("extractClaudeScheduleWakeup", () => {
  it("uses the last valid ScheduleWakeup call and clamps its delay", () => {
    expect(
      extractClaudeScheduleWakeup(
        assistantEvent([
          {
            type: "tool_use",
            name: "ScheduleWakeup",
            input: { delay_seconds: 120, reason: "First check", prompt: "Check CI." },
          },
          {
            type: "tool_use",
            name: "ScheduleWakeup",
            input: { delaySeconds: 9_000, reason: "Final check", prompt: "Check the deploy." },
          },
        ]),
      ),
    ).toEqual({
      delaySeconds: 3_600,
      reason: "Final check",
      prompt: "Check the deploy.",
    });
  });

  it("clamps short delays to one minute", () => {
    expect(
      extractClaudeScheduleWakeup(
        assistantEvent([
          {
            type: "tool_use",
            name: "ScheduleWakeup",
            input: { delay_seconds: 5, reason: "Wait for the process" },
          },
        ]),
      ),
    ).toEqual({
      delaySeconds: 60,
      reason: "Wait for the process",
      prompt: "",
    });
  });

  it("ignores malformed tool input and unrelated raw events", () => {
    expect(
      extractClaudeScheduleWakeup(
        assistantEvent([
          { type: "tool_use", name: "Bash", input: { command: "sleep 5" } },
          {
            type: "tool_use",
            name: "ScheduleWakeup",
            input: { delay_seconds: "60", reason: "Wrong delay type" },
          },
          {
            type: "tool_use",
            name: "ScheduleWakeup",
            input: { delay_seconds: 60, reason: "   " },
          },
        ]),
      ),
    ).toBeNull();
    expect(extractClaudeScheduleWakeup({ type: "result" })).toBeNull();
  });
});

function assistantEvent(content: unknown[]) {
  return {
    type: "assistant",
    message: { id: "msg_1", content },
  };
}
