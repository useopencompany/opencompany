import type {
  AgentSessionQuestionAnswer,
  AgentSessionQuestionPrompt,
} from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import { validateQuestionAnswers } from "./question-validation";

function singleSelect(): AgentSessionQuestionPrompt {
  return {
    header: "Pick one",
    question: "Which environment?",
    options: [{ label: "Staging" }, { label: "Production" }],
    allowMultiple: false,
    allowOther: false,
  };
}

function multiSelect(): AgentSessionQuestionPrompt {
  return {
    header: "Pick some",
    question: "Which regions?",
    options: [{ label: "US" }, { label: "EU" }, { label: "APAC" }],
    allowMultiple: true,
    allowOther: false,
  };
}

function withOther(): AgentSessionQuestionPrompt {
  return {
    header: "Pick or type",
    question: "Favourite tool?",
    options: [{ label: "Vim" }, { label: "Emacs" }],
    allowMultiple: false,
    allowOther: true,
  };
}

function answer(selectedLabels: string[], otherText?: string): AgentSessionQuestionAnswer {
  return otherText === undefined ? { selectedLabels } : { selectedLabels, otherText };
}

describe("validateQuestionAnswers", () => {
  it("accepts a valid single-select answer", () => {
    expect(validateQuestionAnswers([singleSelect()], [answer(["Staging"])])).toBeNull();
  });

  it("accepts a valid multi-select answer", () => {
    expect(validateQuestionAnswers([multiSelect()], [answer(["US", "EU"])])).toBeNull();
  });

  it("rejects when the answer count does not match the question count", () => {
    expect(validateQuestionAnswers([singleSelect()], [])).toBe(
      "Answer every question before submitting.",
    );
    expect(
      validateQuestionAnswers([singleSelect()], [answer(["Staging"]), answer(["Production"])]),
    ).toBe("Answer every question before submitting.");
  });

  it("rejects a non-array answers payload", () => {
    expect(
      validateQuestionAnswers([singleSelect()], null as unknown as AgentSessionQuestionAnswer[]),
    ).toBe("Answer every question before submitting.");
  });

  it("rejects a missing answer entry", () => {
    expect(
      validateQuestionAnswers(
        [singleSelect()],
        [undefined as unknown as AgentSessionQuestionAnswer],
      ),
    ).toBe("Answer every question before submitting.");
  });

  it("rejects an option label that does not exist", () => {
    expect(validateQuestionAnswers([singleSelect()], [answer(["Nope"])])).toBe(
      "Selected an option that does not exist.",
    );
  });

  it("rejects multiple selections when allowMultiple is false", () => {
    expect(validateQuestionAnswers([singleSelect()], [answer(["Staging", "Production"])])).toBe(
      "This question only allows one selection.",
    );
  });

  it("rejects an other text when allowOther is false", () => {
    expect(validateQuestionAnswers([singleSelect()], [answer(["Staging"], "Custom")])).toBe(
      "This question does not allow a custom answer.",
    );
  });

  it("accepts an other text when allowOther is true", () => {
    expect(validateQuestionAnswers([withOther()], [answer([], "Helix")])).toBeNull();
  });

  it("treats whitespace-only other text as empty", () => {
    expect(validateQuestionAnswers([withOther()], [answer([], "   ")])).toBe(
      "Answer every question before submitting.",
    );
  });

  it("rejects an empty selection with no other text", () => {
    expect(validateQuestionAnswers([singleSelect()], [answer([])])).toBe(
      "Answer every question before submitting.",
    );
  });

  it("validates each question independently across a batch", () => {
    expect(
      validateQuestionAnswers(
        [singleSelect(), multiSelect()],
        [answer(["Staging"]), answer(["US", "APAC"])],
      ),
    ).toBeNull();
    expect(
      validateQuestionAnswers(
        [singleSelect(), multiSelect()],
        [answer(["Staging"]), answer(["Mars"])],
      ),
    ).toBe("Selected an option that does not exist.");
  });
});
