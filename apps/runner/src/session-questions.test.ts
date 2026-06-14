import { describe, expect, it } from "vitest";
import {
  buildQuestionAnswerToolOutput,
  buildUnansweredQuestionToolOutput,
  MAX_OPTIONS_PER_QUESTION,
  MAX_QUESTIONS,
  normalizeQuestionsInput,
} from "./session-questions";

describe("normalizeQuestionsInput", () => {
  it("returns null when there are no usable questions", () => {
    expect(normalizeQuestionsInput(undefined)).toBeNull();
    expect(normalizeQuestionsInput({})).toBeNull();
    expect(normalizeQuestionsInput({ questions: [] })).toBeNull();
    // A question with no valid options is dropped.
    expect(
      normalizeQuestionsInput({ questions: [{ question: "Pick one", options: [{}] }] }),
    ).toBeNull();
    // A question with no text is dropped.
    expect(normalizeQuestionsInput({ questions: [{ options: [{ label: "A" }] }] })).toBeNull();
  });

  it("normalizes flags, trims text, and defaults the header to the question", () => {
    const result = normalizeQuestionsInput({
      questions: [
        {
          question: "  Which environment?  ",
          options: [
            { label: " Production ", description: " live " },
            { label: "Staging" },
            { label: "" },
          ],
        },
      ],
    });
    expect(result).toEqual([
      {
        header: "Which environment?",
        question: "Which environment?",
        options: [{ label: "Production", description: "live" }, { label: "Staging" }],
        allowMultiple: false,
        // "Other" is always offered, so the user can always type their own answer.
        allowOther: true,
      },
    ]);
  });

  it("coerces allowMultiple only when strictly true, and always allows other", () => {
    const result = normalizeQuestionsInput({
      questions: [
        {
          header: "Scope",
          question: "What scope?",
          options: [{ label: "A" }, { label: "B" }],
          allowMultiple: true,
        },
      ],
    });
    const question = result?.[0];
    expect(question?.allowMultiple).toBe(true);
    // Always on, independent of model input.
    expect(question?.allowOther).toBe(true);
  });

  it("clamps to the question and option maximums", () => {
    const tooManyQuestions = Array.from({ length: MAX_QUESTIONS + 3 }, (_, index) => ({
      question: `Q${index}`,
      options: [{ label: "A" }, { label: "B" }],
    }));
    const result = normalizeQuestionsInput({ questions: tooManyQuestions });
    expect(result).toHaveLength(MAX_QUESTIONS);

    const tooManyOptions = {
      questions: [
        {
          question: "Q",
          options: Array.from({ length: MAX_OPTIONS_PER_QUESTION + 4 }, (_, i) => ({
            label: `Opt ${i}`,
          })),
        },
      ],
    };
    expect(normalizeQuestionsInput(tooManyOptions)?.[0]?.options).toHaveLength(
      MAX_OPTIONS_PER_QUESTION,
    );
  });
});

describe("buildQuestionAnswerToolOutput", () => {
  it("pairs each question with its selected labels and free-text other", () => {
    const questions = [
      {
        header: "Env",
        question: "Which environment?",
        options: [{ label: "Production" }, { label: "Staging" }],
        allowMultiple: false,
        allowOther: true,
      },
      {
        header: "Scope",
        question: "What scope?",
        options: [{ label: "Web" }, { label: "API" }],
        allowMultiple: true,
        allowOther: false,
      },
    ];
    const output = buildQuestionAnswerToolOutput(questions, [
      { selectedLabels: [], otherText: "A preview branch" },
      { selectedLabels: ["Web", "API"] },
    ]);
    expect(output).toEqual({
      status: "answered",
      answers: [
        {
          header: "Env",
          question: "Which environment?",
          selected: [],
          other: "A preview branch",
        },
        { header: "Scope", question: "What scope?", selected: ["Web", "API"] },
      ],
    });
  });

  it("tolerates missing answers", () => {
    const output = buildQuestionAnswerToolOutput(
      [
        {
          header: "Env",
          question: "Which?",
          options: [{ label: "A" }],
          allowMultiple: false,
          allowOther: false,
        },
      ],
      null,
    );
    expect(output.answers[0]).toEqual({ header: "Env", question: "Which?", selected: [] });
  });
});

describe("buildUnansweredQuestionToolOutput", () => {
  it("explains why the question went unanswered", () => {
    expect(buildUnansweredQuestionToolOutput("timeout").reason).toContain("in time");
    expect(buildUnansweredQuestionToolOutput("abort").reason).toContain("stopped");
    expect(buildUnansweredQuestionToolOutput("superseded").reason).toContain("dismissed");
    expect(buildUnansweredQuestionToolOutput(null).status).toBe("unanswered");
  });
});
