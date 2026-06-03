import type {
  AgentSessionQuestionAnswer,
  AgentSessionQuestionPrompt,
  AgentSessionQuestionResolutionSource,
} from "@opencompany/agent-runtime";
import { agentSessionQuestions } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";

// The ask_user_question flow mirrors tool approvals: the model's tool-call suspends the run and
// writes a pending row; a web action / backstop flips it to answered/cancelled and the resume run
// reads the decided row here to synthesize the tool-result. See tool-approvals.ts for the parallel.

export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS_PER_QUESTION = 6;

export type SessionQuestionRow = {
  status: "pending" | "answered" | "cancelled";
  resolutionSource: AgentSessionQuestionResolutionSource | null;
  messageId: string | null;
  questions: AgentSessionQuestionPrompt[];
  answers: AgentSessionQuestionAnswer[] | null;
};

export async function loadSessionQuestion(
  sessionId: string,
  toolCallId: string,
): Promise<SessionQuestionRow | null> {
  const [row] = await getDb()
    .select({
      status: agentSessionQuestions.status,
      resolutionSource: agentSessionQuestions.resolutionSource,
      messageId: agentSessionQuestions.messageId,
      questions: agentSessionQuestions.questions,
      answers: agentSessionQuestions.answers,
    })
    .from(agentSessionQuestions)
    .where(
      and(
        eq(agentSessionQuestions.sessionId, sessionId),
        eq(agentSessionQuestions.toolCallId, toolCallId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Validate and clamp the model's raw tool input into the durable question shape. Returns null when
// the input has no usable questions, so the caller can fall back to a failed tool-result instead of
// suspending the run on garbage.
export function normalizeQuestionsInput(rawInput: unknown): AgentSessionQuestionPrompt[] | null {
  const root = rawInput as { questions?: unknown } | null | undefined;
  const rawQuestions = Array.isArray(root?.questions) ? root.questions : [];
  const normalized: AgentSessionQuestionPrompt[] = [];

  for (const rawQuestion of rawQuestions.slice(0, MAX_QUESTIONS)) {
    const q = rawQuestion as Record<string, unknown> | null | undefined;
    if (!q) continue;
    const header = typeof q.header === "string" ? q.header.trim() : "";
    const question = typeof q.question === "string" ? q.question.trim() : "";
    if (!question) continue;

    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options = rawOptions.slice(0, MAX_OPTIONS_PER_QUESTION).flatMap((rawOption) => {
      const o = rawOption as Record<string, unknown> | null | undefined;
      const label = typeof o?.label === "string" ? o.label.trim() : "";
      if (!label) return [];
      const description =
        typeof o?.description === "string" && o.description.trim()
          ? o.description.trim()
          : undefined;
      return [description ? { label, description } : { label }];
    });
    if (options.length === 0) continue;

    normalized.push({
      header: header || question.slice(0, 40),
      question,
      options,
      allowMultiple: q.allowMultiple === true,
      allowOther: q.allowOther === true,
    });
  }

  return normalized.length > 0 ? normalized : null;
}

// Encodes the user's answers as a model-friendly tool-result. Pairs each question with the labels
// the user picked plus any free-text "other", so the model can read the decision back cleanly.
export function buildQuestionAnswerToolOutput(
  questions: AgentSessionQuestionPrompt[],
  answers: AgentSessionQuestionAnswer[] | null,
) {
  return {
    status: "answered" as const,
    answers: questions.map((question, index) => {
      const answer = answers?.[index];
      return {
        header: question.header,
        question: question.question,
        selected: answer?.selectedLabels ?? [],
        ...(answer?.otherText ? { other: answer.otherText } : {}),
      };
    }),
  };
}

// Synthesized result for a question the user never answered (cancelled via the X, superseded by a
// new message, aborted, or timed out). Tells the model to move on rather than silently re-ask.
export function buildUnansweredQuestionToolOutput(
  resolutionSource: AgentSessionQuestionResolutionSource | null,
) {
  const reason =
    resolutionSource === "timeout"
      ? "The user did not answer in time."
      : resolutionSource === "abort"
        ? "The session was stopped before the user answered."
        : "The user dismissed the question without answering.";
  return {
    status: "unanswered" as const,
    reason: `${reason} Proceed using your best judgment or ask again only if truly necessary.`,
  };
}
