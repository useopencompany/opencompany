import { normalizeLinearIssueWindow } from "@opencompany/brain";
import { describe, expect, it } from "vitest";
import {
  type BufferedLinearEventRow,
  classifyLinearIssueWindowForIngest,
  resolveLinearIssueWindowRoutes,
} from "./linear-flush-worker";

function linearIssueWindow(
  activity: Parameters<typeof normalizeLinearIssueWindow>[0]["activity"],
  overrides: Partial<Parameters<typeof normalizeLinearIssueWindow>[0]> = {},
) {
  return normalizeLinearIssueWindow({
    windowId: "glinwin_test",
    organizationId: "org_123",
    issueId: "issue_123",
    title: "Add GitHub as source",
    identifier: "G-51",
    state: "Done",
    teamId: "team_123",
    activity,
    flushedAt: "2026-07-10T10:15:00.000Z",
    ...overrides,
  });
}

describe("classifyLinearIssueWindowForIngest", () => {
  it("skips routine status-only issue updates", () => {
    const item = linearIssueWindow([
      {
        occurredAt: "2026-07-10T10:00:00.000Z",
        entityType: "issue",
        action: "update",
        changedFields: ["stateId"],
      },
    ]);

    expect(classifyLinearIssueWindowForIngest(item)).toEqual({
      action: "skip",
      reason: "routine_linear_status_change",
    });
  });

  it("skips routine metadata-only issue updates", () => {
    const item = linearIssueWindow([
      {
        occurredAt: "2026-07-10T10:00:00.000Z",
        entityType: "issue",
        action: "update",
        changedFields: ["assigneeId", "estimate"],
      },
    ]);

    expect(classifyLinearIssueWindowForIngest(item)).toEqual({
      action: "skip",
      reason: "routine_linear_metadata_update",
    });
  });

  it("skips mixed routine updates but ingests any substantive field", () => {
    expect(
      classifyLinearIssueWindowForIngest(
        linearIssueWindow([
          {
            occurredAt: "2026-07-10T10:00:00.000Z",
            entityType: "issue",
            action: "update",
            changedFields: ["assigneeId"],
          },
          {
            occurredAt: "2026-07-10T10:01:00.000Z",
            entityType: "issue",
            action: "update",
            changedFields: ["stateId"],
          },
        ]),
      ),
    ).toEqual({
      action: "skip",
      reason: "routine_linear_status_change",
    });

    expect(
      classifyLinearIssueWindowForIngest(
        linearIssueWindow([
          {
            occurredAt: "2026-07-10T10:00:00.000Z",
            entityType: "issue",
            action: "update",
            changedFields: ["stateId", "description"],
          },
        ]),
      ),
    ).toEqual({ action: "ingest" });
  });

  it("ingests issue creation and comment activity", () => {
    expect(
      classifyLinearIssueWindowForIngest(
        linearIssueWindow([
          {
            occurredAt: "2026-07-10T10:00:00.000Z",
            entityType: "issue",
            action: "create",
          },
        ]),
      ),
    ).toEqual({ action: "ingest" });

    expect(
      classifyLinearIssueWindowForIngest(
        linearIssueWindow([
          {
            occurredAt: "2026-07-10T10:00:00.000Z",
            entityType: "comment",
            action: "create",
            commentId: "comment_123",
            commentBody: "We should use Signoz for LLM observability.",
          },
        ]),
      ),
    ).toEqual({ action: "ingest" });
  });

  it("ingests substantive, unknown, and stale issue updates", () => {
    expect(
      classifyLinearIssueWindowForIngest(
        linearIssueWindow([
          {
            occurredAt: "2026-07-10T10:00:00.000Z",
            entityType: "issue",
            action: "update",
            changedFields: ["description"],
          },
        ]),
      ),
    ).toEqual({ action: "ingest" });

    expect(
      classifyLinearIssueWindowForIngest(
        linearIssueWindow([
          {
            occurredAt: "2026-07-10T10:00:00.000Z",
            entityType: "issue",
            action: "update",
          },
        ]),
      ),
    ).toEqual({ action: "ingest" });

    expect(
      classifyLinearIssueWindowForIngest(
        linearIssueWindow(
          [
            {
              occurredAt: "2026-07-10T10:00:00.000Z",
              entityType: "issue",
              action: "update",
              changedFields: ["stateId"],
            },
          ],
          { snapshotStale: true },
        ),
      ),
    ).toEqual({ action: "ingest" });
  });

  it("skips empty issue windows", () => {
    const item = linearIssueWindow([
      {
        occurredAt: "2026-07-10T10:00:00.000Z",
        entityType: "issue",
        action: "update",
        changedFields: ["stateId"],
      },
    ]);

    expect(
      classifyLinearIssueWindowForIngest({
        ...item,
        content: {
          ...item.content,
          issue: {
            ...item.content.issue,
            activity: [],
          },
        },
      }),
    ).toEqual({
      action: "skip",
      reason: "routine_linear_metadata_update",
    });
  });
});

describe("resolveLinearIssueWindowRoutes", () => {
  const event: BufferedLinearEventRow = {
    id: "glinevt_1",
    deliveryId: "delivery_1",
    teamId: "team_1",
    entityType: "issue",
    action: "create",
    issueTitle: "Billing bug",
    actorName: "Ada",
    payload: { data: { id: "issue_1" } },
    eventTime: "2026-07-10T10:00:00.000Z",
  };
  const brainRoute = {
    integrationId: "gint_1",
    brainRef: "gbrain_1",
    config: {
      teams: [{ id: "team_1", name: "Core" }],
      events: [{ id: "issue_created" as const }],
    },
  };
  const wikiRoute = {
    integrationId: "gint_1",
    workspaceId: "workspace_1",
    config: {
      teams: [{ id: "team_1", name: "Core" }],
      events: [{ id: "issue_created" as const }],
    },
  };

  it("matches scoped brain and wiki routes without changing the brain result", () => {
    expect(
      resolveLinearIssueWindowRoutes({
        brainRoutes: [brainRoute],
        wikiRoutes: [wikiRoute],
        teamId: "team_1",
        events: [event],
      }),
    ).toEqual({ brainRefs: ["gbrain_1"], wikiWorkspaceIds: ["workspace_1"] });
  });

  it("supports wiki-only and brain-only routing", () => {
    expect(
      resolveLinearIssueWindowRoutes({
        brainRoutes: [],
        wikiRoutes: [wikiRoute],
        teamId: "team_1",
        events: [event],
      }),
    ).toEqual({ brainRefs: [], wikiWorkspaceIds: ["workspace_1"] });
    expect(
      resolveLinearIssueWindowRoutes({
        brainRoutes: [brainRoute],
        wikiRoutes: [],
        teamId: "team_1",
        events: [event],
      }),
    ).toEqual({ brainRefs: ["gbrain_1"], wikiWorkspaceIds: [] });
  });

  it("rejects wiki routes outside the selected team or event scope", () => {
    expect(
      resolveLinearIssueWindowRoutes({
        brainRoutes: [],
        wikiRoutes: [wikiRoute],
        teamId: "team_other",
        events: [event],
      }),
    ).toEqual({ brainRefs: [], wikiWorkspaceIds: [] });
  });
});
