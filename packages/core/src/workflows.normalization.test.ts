import { expect, it } from "vitest";
import { actor, fakeWorkflowRepository, workflow, workflowService } from "./workflows.test-support";

it("saves exact tag pairs without trimming their values and rejects duplicate keys", async () => {
  const repository = fakeWorkflowRepository();
  const service = workflowService(repository);
  const definition = {
    expectedVersion: 1,
    name: "Sentry investigation",
    description: "",
    steps: workflow().steps,
    status: "draft" as const,
    trigger: {
      type: "event" as const,
      provider: "sentry",
      event: "issue.created",
      integrationId: "sentry_1",
      filters: {
        project: { id: "1", name: "Web" },
        tags: { id: "exact", name: "Exact tags", pairs: [{ key: "tenant", value: " acme " }] },
      },
      prompt: "Investigate",
    },
  };
  await service.updateWorkflow(actor(), "workflow_1", definition);
  expect(repository.updateWorkflow).toHaveBeenCalledWith(
    expect.objectContaining({
      trigger: expect.objectContaining({
        filters: expect.objectContaining({
          tags: expect.objectContaining({ pairs: [{ key: "tenant", value: " acme " }] }),
        }),
      }),
    }),
  );
  await expect(
    service.updateWorkflow(actor(), "workflow_1", {
      ...definition,
      trigger: {
        ...definition.trigger,
        filters: {
          ...definition.trigger.filters,
          tags: {
            ...definition.trigger.filters.tags,
            pairs: [
              { key: "tenant", value: "a" },
              { key: "tenant", value: "b" },
            ],
          },
        },
      },
    }),
  ).rejects.toThrow("Tag keys must be unique");
});

it("saves a coding step's repository and rejects an invalid base branch", async () => {
  const repository = fakeWorkflowRepository();
  const service = workflowService(repository);
  const [step] = workflow().steps;
  const definition = {
    expectedVersion: 1,
    name: "Sentry fix",
    description: "",
    status: "draft" as const,
    trigger: { type: "manual" as const },
    steps: [
      {
        ...step!,
        model: "codex",
        repository: { fullName: "acme/service", baseBranch: "release/stable" },
      },
    ],
  };
  await service.updateWorkflow(actor(), "workflow_1", definition);
  expect(repository.updateWorkflow).toHaveBeenCalledWith(
    expect.objectContaining({
      steps: [
        expect.objectContaining({
          repository: { fullName: "acme/service", baseBranch: "release/stable" },
        }),
      ],
    }),
  );
  await expect(
    service.updateWorkflow(actor(), "workflow_1", {
      ...definition,
      steps: [
        { ...definition.steps[0]!, repository: { fullName: "acme/service", baseBranch: "a..b" } },
      ],
    }),
  ).rejects.toThrow("valid base branch");
});
