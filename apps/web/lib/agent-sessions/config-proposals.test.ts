import { describe, expect, it } from "vitest";
import {
  type OpenCompanyConfigProposal,
  placeOpenCompanyConfigProposals,
} from "@/lib/agent-sessions/config-proposals";

describe("OpenCompany config proposal placement", () => {
  it("places matching proposals after their visible message", () => {
    const placement = placeOpenCompanyConfigProposals(
      [proposal({ id: 1, messageId: "msg_assistant" })],
      ["msg_user_before", "msg_assistant", "msg_user_after"],
    );

    const timeline = ["msg_user_before", "msg_assistant", "msg_user_after"].flatMap((messageId) => [
      `message:${messageId}`,
      ...(placement.byMessageId.get(messageId) ?? []).map((item) => `proposal:${item.id}`),
    ]);

    expect(timeline).toEqual([
      "message:msg_user_before",
      "message:msg_assistant",
      "proposal:1",
      "message:msg_user_after",
    ]);
    expect(placement.orphaned).toEqual([]);
  });

  it("sorts multiple proposals for one message by creation time then id", () => {
    const placement = placeOpenCompanyConfigProposals(
      [
        proposal({ id: 3, messageId: "msg_assistant", createdAt: "2026-05-24T10:02:00.000Z" }),
        proposal({ id: 2, messageId: "msg_assistant", createdAt: "2026-05-24T10:01:00.000Z" }),
        proposal({ id: 1, messageId: "msg_assistant", createdAt: "2026-05-24T10:01:00.000Z" }),
      ],
      ["msg_assistant"],
    );

    expect(placement.byMessageId.get("msg_assistant")?.map((item) => item.id)).toEqual([1, 2, 3]);
  });

  it("keeps unmatched proposals in the fallback group", () => {
    const matched = proposal({ id: 1, messageId: "msg_assistant" });
    const missingMessage = proposal({ id: 2, messageId: "msg_missing" });
    const noMessage = proposal({ id: 3, messageId: null });

    const placement = placeOpenCompanyConfigProposals(
      [noMessage, matched, missingMessage],
      ["msg_assistant"],
    );

    expect(placement.byMessageId.get("msg_assistant")).toEqual([matched]);
    expect(placement.orphaned).toEqual([missingMessage, noMessage]);
  });
});

function proposal(
  overrides: Partial<OpenCompanyConfigProposal> & { id: number },
): OpenCompanyConfigProposal {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId ?? "ses_123",
    messageId: overrides.messageId ?? "msg_123",
    toolCallId: overrides.toolCallId ?? "call_123",
    title: overrides.title ?? `Proposal ${overrides.id}`,
    status: overrides.status ?? "pending",
    summary: overrides.summary ?? `Proposal ${overrides.id}`,
    changes: overrides.changes ?? [
      {
        targetType: "brain",
        operation: "create",
        path: `proposal-${overrides.id}.md`,
        content: "content",
        previousHash: null,
        contentHash: `hash-${overrides.id}`,
      },
    ],
    createdAt: overrides.createdAt ?? `2026-05-24T10:0${overrides.id}:00.000Z`,
    error: overrides.error ?? null,
  };
}
