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

  it("accepts a poll-delivered event that declares no filters", async () => {
    const execute = vi.fn(async () => ({
      rows: [
        {
          integrationId: "gint_granola_1",
          events: [
            {
              id: "meeting.notes_ready",
              label: "Meeting notes ready",
              description: "Starts once the summary is generated.",
              delivery: "poll",
              filters: [],
            },
          ],
          eventModes: { "meeting.notes_ready": true },
        },
      ],
    }));

    await expect(
      validateWorkflowEventSubscription(execute, {
        actor,
        trigger: {
          ...trigger,
          provider: "granola",
          event: "meeting.notes_ready",
          integrationId: "gint_granola_1",
          filters: {},
        },
      }),
    ).resolves.toBeNull();
  });

  it("rejects a filter the declaration does not declare", async () => {
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
      validateWorkflowEventSubscription(execute, {
        actor,
        trigger: { ...trigger, filters: { project: { id: "project_1", name: "Roadmap" } } },
      }),
    ).resolves.toMatch(/does not declare/i);
  });

  it("requires legacy triage subscriptions to use a declared personal plugin event", async () => {
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
    ).resolves.toMatch(/enable/i);
  });
});

it("rejects unsupported choice values even for an enabled plugin event", async () => {
  const execute = vi.fn(async () => ({
    rows: [
      {
        integrationId: trigger.integrationId,
        events: [
          {
            ...declaration,
            filters: [
              {
                id: "status",
                label: "Status",
                kind: "choice",
                required: false,
                options: [{ id: "triage", name: "Triage" }],
              },
            ],
          },
        ],
        eventModes: { "issue.created": true },
      },
    ],
  }));
  await expect(
    validateWorkflowEventSubscription(execute, {
      actor,
      trigger: { ...trigger, filters: { status: { id: "invented", name: "Invented" } } },
    }),
  ).resolves.toMatch(/supported value/);
  await expect(
    validateWorkflowEventSubscription(execute, {
      actor,
      trigger: { ...trigger, filters: { status: { id: "triage", name: "Triage" } } },
    }),
  ).resolves.toBeNull();
});
