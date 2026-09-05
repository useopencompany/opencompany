import type { Actor, WorkflowEventTrigger } from "@opencompany/core";
import { describe, expect, it, vi } from "vitest";
import { validateWorkflowEventSubscription } from "./workflow-event-subscriptions";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: [],
  authenticationMethod: "session",
};

const trigger: WorkflowEventTrigger = {
  type: "event",
  provider: "linear",
  event: "issue.created",
  integrationId: "gint_linear_1",
  filters: { team: { id: "team_1", name: "Engineering" } },
  prompt: "Review the issue.",
};

const declaration = {
  id: "issue.created",
  label: "Issue created",
  description: "Starts when an issue is created.",
  delivery: "webhook",
  filters: [
    {
      id: "team",
      label: "Team",
      kind: "integration_resource",
      resourceType: "team",
      required: true,
    },
  ],
};

describe("workflow event subscription validation", () => {
  it("accepts declared, enabled events with required filters", async () => {
    const execute = vi.fn(async () => ({
      rows: [
        {
          integrationId: trigger.integrationId,
          events: [declaration],
          eventModes: { "issue.created": true },
        },
      ],
    }));

    await expect(
      validateWorkflowEventSubscription(execute, { actor, trigger }),
    ).resolves.toBeNull();
  });

  it("rejects disabled events and missing required filters", async () => {
    const disabled = vi.fn(async () => ({
      rows: [{ integrationId: trigger.integrationId, events: [declaration], eventModes: {} }],
    }));
    await expect(validateWorkflowEventSubscription(disabled, { actor, trigger })).resolves.toMatch(
      /enable/i,
    );

    const missingFilter = vi.fn(async () => ({
      rows: [
        {
          integrationId: trigger.integrationId,
          events: [declaration],
          eventModes: { "issue.created": true },
        },
      ],
    }));
    await expect(
      validateWorkflowEventSubscription(missingFilter, {
        actor,
        trigger: { ...trigger, filters: {} },
      }),
    ).resolves.toMatch(/required/i);
  });

  it("keeps the legacy Linear triage alias available", async () => {
    const execute = vi.fn(async () => ({
      rows: [{ integrationId: trigger.integrationId, events: [], eventModes: {} }],
    }));
    await expect(
      validateWorkflowEventSubscription(execute, {
        actor,
        trigger: {
          ...trigger,
          event: "issue_enters_triage",
          filters: {
            team: {
              id: "team_1",
              name: "Engineering",
              metadata: { triageStateId: "state_triage" },
            },
          },
        },
      }),
    ).resolves.toBeNull();
  });
});
