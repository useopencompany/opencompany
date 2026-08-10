import { describe, expect, it } from "vitest";
import { parseCodexUserInputResponse } from "./codex-chat-interactions";

const request = {
  threadId: "thread_1",
  turnId: "turn_1",
  itemId: "question_1",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "How broad should the fix be?",
      options: [{ label: "Foundational", description: "Harden the full path." }],
    },
    {
      id: "tests",
      header: "Tests",
      question: "Which tests should run?",
      options: null,
    },
  ],
};

describe("parseCodexUserInputResponse", () => {
  it("accepts the exact app-server answer map and trims values", () => {
    expect(
      parseCodexUserInputResponse(request, {
        scope: { answers: [" Foundational ", "user_note: include recovery"] },
        tests: { answers: [" targeted and typecheck "] },
      }),
    ).toEqual({
      ok: true,
      response: {
        answers: {
          scope: { answers: ["Foundational", "user_note: include recovery"] },
          tests: { answers: ["targeted and typecheck"] },
        },
      },
    });
  });

  it("rejects missing, extra, malformed, and oversized answers", () => {
    expect(
      parseCodexUserInputResponse(request, {
        scope: { answers: ["Foundational"] },
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      parseCodexUserInputResponse(request, {
        scope: { answers: ["Foundational"] },
        tests: { answers: ["targeted"] },
        injected: { answers: ["bad"] },
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      parseCodexUserInputResponse(request, {
        scope: { answers: [42] },
        tests: { answers: ["targeted"] },
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      parseCodexUserInputResponse(request, {
        scope: { answers: ["x".repeat(4_001)] },
        tests: { answers: ["targeted"] },
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects malformed question batches instead of silently truncating them", () => {
    expect(
      parseCodexUserInputResponse(
        {
          questions: [
            ...request.questions,
            { id: "third", header: "Third", question: "Third?" },
            { id: "fourth", header: "Fourth", question: "Fourth?" },
          ],
        },
        {},
      ),
    ).toMatchObject({ ok: false, status: 400, error: "Codex sent an invalid question." });
  });
});
