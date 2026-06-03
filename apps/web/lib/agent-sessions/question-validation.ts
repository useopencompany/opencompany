import type {
  AgentSessionQuestionAnswer,
  AgentSessionQuestionPrompt,
} from "@opencompany/agent-runtime";

// Validate the submitted answers against the questions the model asked. Returns an error string
// when the shape is wrong so a malformed submit never flips the row. One answer per question, in
// order; every selected label must be a real option; multi-select only when allowMultiple; an
// "other" text only when allowOther; and every question must end up with at least one selection.
//
// Kept as a pure module (no server/runtime deps) so it can be unit-tested directly rather than
// through mocked server-action tests.
export function validateQuestionAnswers(
  questions: AgentSessionQuestionPrompt[],
  answers: AgentSessionQuestionAnswer[],
): string | null {
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    return "Answer every question before submitting.";
  }
  for (const [index, question] of questions.entries()) {
    const answer = answers[index];
    if (!answer) return "Answer every question before submitting.";
    const optionLabels = new Set(question.options.map((option) => option.label));
    const selected = Array.isArray(answer.selectedLabels) ? answer.selectedLabels : [];
    for (const label of selected) {
      if (!optionLabels.has(label)) {
        return "Selected an option that does not exist.";
      }
    }
    if (selected.length > 1 && !question.allowMultiple) {
      return "This question only allows one selection.";
    }
    const otherText = typeof answer.otherText === "string" ? answer.otherText.trim() : "";
    if (otherText && !question.allowOther) {
      return "This question does not allow a custom answer.";
    }
    if (selected.length === 0 && !otherText) {
      return "Answer every question before submitting.";
    }
  }
  return null;
}
