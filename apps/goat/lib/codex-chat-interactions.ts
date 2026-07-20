import { getDb } from "@opencompany/db/client";
import { goatCodexChatInteractions, goatCodexChatTurns } from "@opencompany/db/goat-schema";
import { and, eq, sql } from "drizzle-orm";

const MAX_QUESTIONS = 3;
const MAX_ANSWERS_PER_QUESTION = 8;
const MAX_ANSWER_LENGTH = 4_000;
const MAX_TOTAL_ANSWER_LENGTH = 12_000;

export type CodexUserInputResponse = {
  answers: Record<string, { answers: string[] }>;
};

export async function resolveGoatCodexChatInteraction(input: {
  userWorkosId: string;
  interactionId: string;
  answers: unknown;
}): Promise<
  | { ok: true; response: CodexUserInputResponse }
  | { ok: false; status: 400 | 404 | 409; error: string }
> {
  const [interaction] = await getDb()
    .select({
      request: goatCodexChatInteractions.request,
      status: goatCodexChatInteractions.status,
      turnStatus: goatCodexChatTurns.status,
    })
    .from(goatCodexChatInteractions)
    .innerJoin(
      goatCodexChatTurns,
      eq(goatCodexChatTurns.id, goatCodexChatInteractions.codexChatTurnId),
    )
    .where(
      and(
        eq(goatCodexChatInteractions.id, input.interactionId),
        eq(goatCodexChatInteractions.userWorkosId, input.userWorkosId),
        eq(goatCodexChatInteractions.leaseId, goatCodexChatTurns.leaseId),
      ),
    )
    .limit(1);
  if (!interaction) return { ok: false, status: 404, error: "Codex question not found." };
  if (interaction.status !== "pending" || interaction.turnStatus !== "running") {
    return { ok: false, status: 409, error: "This Codex question is no longer waiting." };
  }

  const parsed = parseCodexUserInputResponse(interaction.request, input.answers);
  if (!parsed.ok) return parsed;

  const now = new Date();
  const [resolved] = await getDb()
    .update(goatCodexChatInteractions)
    .set({
      status: "resolved",
      response: parsed.response,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(goatCodexChatInteractions.id, input.interactionId),
        eq(goatCodexChatInteractions.userWorkosId, input.userWorkosId),
        eq(goatCodexChatInteractions.status, "pending"),
        sql`EXISTS (
          SELECT 1
          FROM ${goatCodexChatTurns} AS current_turn
          WHERE current_turn.id = ${goatCodexChatInteractions.codexChatTurnId}
            AND current_turn.status = 'running'
            AND current_turn.lease_id = ${goatCodexChatInteractions.leaseId}
        )`,
      ),
    )
    .returning({ id: goatCodexChatInteractions.id });
  if (!resolved) {
    return { ok: false, status: 409, error: "This Codex question was already answered." };
  }

  return { ok: true, response: parsed.response };
}

export function parseCodexUserInputResponse(
  request: Record<string, unknown>,
  value: unknown,
): { ok: true; response: CodexUserInputResponse } | { ok: false; status: 400; error: string } {
  const rawQuestions = Array.isArray(request.questions) ? request.questions : [];
  if (rawQuestions.some((question) => !isRecord(question))) {
    return { ok: false, status: 400, error: "Codex sent an invalid question." };
  }
  const questions = rawQuestions as Record<string, unknown>[];
  if (questions.length === 0 || questions.length > MAX_QUESTIONS) {
    return { ok: false, status: 400, error: "Codex sent an invalid question." };
  }
  if (!isRecord(value)) {
    return { ok: false, status: 400, error: "Answers are required." };
  }

  const expectedIds = questions
    .map((question) => (typeof question.id === "string" ? question.id : ""))
    .filter(Boolean);
  if (expectedIds.length !== questions.length) {
    return { ok: false, status: 400, error: "Codex sent an invalid question." };
  }
  if (new Set(expectedIds).size !== expectedIds.length) {
    return { ok: false, status: 400, error: "Codex sent an invalid question." };
  }
  if (Object.keys(value).some((id) => !expectedIds.includes(id))) {
    return { ok: false, status: 400, error: "An answer did not match the Codex question." };
  }

  let totalLength = 0;
  const answerEntries: Array<[string, { answers: string[] }]> = [];
  for (const id of expectedIds) {
    const entry = value[id];
    if (!isRecord(entry) || !Array.isArray(entry.answers)) {
      return { ok: false, status: 400, error: "Answer every Codex question." };
    }
    if (entry.answers.some((answer) => typeof answer !== "string")) {
      return { ok: false, status: 400, error: "A Codex answer is invalid." };
    }
    const values = entry.answers
      .filter((answer): answer is string => typeof answer === "string")
      .map((answer) => answer.trim())
      .filter(Boolean);
    if (values.length === 0 || values.length > MAX_ANSWERS_PER_QUESTION) {
      return { ok: false, status: 400, error: "Answer every Codex question." };
    }
    if (values.some((answer) => answer.length > MAX_ANSWER_LENGTH)) {
      return { ok: false, status: 400, error: "A Codex answer is too long." };
    }
    totalLength += values.reduce((sum, answer) => sum + answer.length, 0);
    answerEntries.push([id, { answers: values }]);
  }
  if (totalLength > MAX_TOTAL_ANSWER_LENGTH) {
    return { ok: false, status: 400, error: "The Codex answers are too long." };
  }

  return { ok: true, response: { answers: Object.fromEntries(answerEntries) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
