import { UpdateWorkflowBodySchema } from "@opencompany/protocol";
import { expect, it } from "vitest";
import { prepareSentryTemplate } from "./sentry-template-setup";
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
  const definition = prepareSentryTemplate(template("investigate-sentry-issues"), setup);
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
    const definition = prepareSentryTemplate(template("propose-sentry-fix"), {
      ...setup,
      engine,
      repository: "acme/service",
      baseBranch: "release/stable",
    });
    expect(definition.step).toMatchObject({
      model: engine,
      runtimeModel: engine === "codex" ? "openai/gpt-5.6-sol" : "anthropic/claude-sonnet-5",
      repository: { fullName: "acme/service", baseBranch: "release/stable" },
    });
    expect(definition.step.instructions).toBe(template("propose-sentry-fix").step.instructions);
  },
);
it("saves the chosen daily wall clock and timezone without event triggers or writes", () => {
  const definition = prepareSentryTemplate(template("daily-sentry-review"), {
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
  expect(() => prepareSentryTemplate(template("propose-sentry-fix"), setup)).toThrow(
    "Choose a coding engine",
  );
  expect(() =>
    prepareSentryTemplate(template("investigate-sentry-issues"), {
      ...setup,
      tags: [
        { key: "a", value: "b" },
        { key: "a", value: "c" },
      ],
    }),
  ).toThrow("unique");
  expect(() =>
    prepareSentryTemplate(template("daily-sentry-review"), {
      ...setup,
      time: "09:00",
      timezone: "bad",
    }),
  ).toThrow("valid timezone");
});

it("accepts catalog projects with metadata while keeping saved filters within the API contract", () => {
  const project = { id: "1", name: "Web", slug: "web", platform: "javascript" };
  const definition = prepareSentryTemplate(template("investigate-sentry-issues"), {
    ...setup,
    project,
  });
  expect(
    UpdateWorkflowBodySchema.pick({ triggers: true }).safeParse({
      triggers: definition.triggers.map((trigger, index) => ({
        ...trigger,
        id: `trigger_${index}`,
      })),
    }).success,
  ).toBe(true);
});
