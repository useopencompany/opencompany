import { expect, it } from "vitest";
import { sentryTemplateDefinition } from "./sentry-template-setup";
import { WORKFLOW_TEMPLATES } from "./workflow-templates";

const setup = {
  integrationId: "sentry_1",
  project: { id: "1", name: "Web" },
  priority: "high",
  environment: "production",
  tags: [{ key: "tenant", value: "acme" }],
};
function template(id: string) {
  return WORKFLOW_TEMPLATES.find((template) => template.id === id)!;
}
it("prefills creation and regression with the same saved conditions and a concrete normal model", () => {
  const definition = sentryTemplateDefinition(template("investigate-sentry-issues"), setup);
  expect(definition.triggers).toMatchObject([
    {
      event: "issue.created",
      filters: {
        project: setup.project,
        environment: { id: "production" },
        priority: { id: "high" },
        tags: { pairs: setup.tags },
      },
    },
    { event: "issue.regressed", filters: { tags: { pairs: setup.tags } } },
  ]);
  expect(definition.step.model).toBe("kimi-k2.6");
});
it.each(["codex", "claude-code"] as const)(
  "persists %s and explicit repository and branch in a single coding step",
  (engine) => {
    const definition = sentryTemplateDefinition(template("propose-sentry-fix"), {
      ...setup,
      engine,
      repository: "acme/service",
      baseBranch: "release/stable",
    });
    expect(definition.step).toMatchObject({
      model: engine,
      runtimeModel: engine === "codex" ? "openai/gpt-5.6-sol" : "anthropic/claude-sonnet-5",
    });
    expect(definition.step.instructions).toContain(
      'Sentry fix configuration: {"repository":"acme/service","baseBranch":"release/stable","engine":"' +
        engine +
        '"}',
    );
    expect(definition.step.instructions).toContain("Never assign, resolve or archive");
  },
);
it("saves the chosen daily wall clock and timezone without event triggers or writes", () => {
  const definition = sentryTemplateDefinition(template("daily-sentry-review"), {
    ...setup,
    time: "09:00",
    timezone: "Europe/Berlin",
  });
  expect(definition.triggers).toEqual([
    {
      type: "schedule",
      cron: "0 9 * * *",
      timezone: "Europe/Berlin",
      prompt: "Review the preceding 24 hours of unresolved Sentry issues.",
      enabled: true,
    },
  ]);
  expect(definition.step.instructions).toContain("Perform no writes");
  expect(definition.step.instructions).toContain("Selected Sentry project ID: 1");
});
it("rejects incomplete fix configuration, duplicate tags and invalid timezones before cloning", () => {
  expect(() => sentryTemplateDefinition(template("propose-sentry-fix"), setup)).toThrow(
    "Choose a coding engine",
  );
  expect(() =>
    sentryTemplateDefinition(template("investigate-sentry-issues"), {
      ...setup,
      tags: [
        { key: "a", value: "b" },
        { key: "a", value: "c" },
      ],
    }),
  ).toThrow("unique");
  expect(() =>
    sentryTemplateDefinition(template("daily-sentry-review"), {
      ...setup,
      time: "09:00",
      timezone: "bad",
    }),
  ).toThrow("valid timezone");
});
