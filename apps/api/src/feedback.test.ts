import type { Actor } from "@opencompany/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { createFeedbackService } from "./feedback";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "gws_1",
  role: "member",
  permissions: [],
  authenticationMethod: "session",
};

function fakeDb(rows: { user?: unknown[]; workspace?: unknown[] } = {}) {
  const results = [
    rows.user ?? [{ email: "ana@acme.example", firstName: "Ana", lastName: "Ng" }],
    rows.workspace ?? [{ id: "gws_1", name: "Acme" }],
  ];
  let call = 0;
  return {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => results[call++] ?? [],
        }),
      }),
    })),
  };
}

function linearOk<T>(data: T) {
  return { ok: true, json: async () => ({ data }) } as unknown as Response;
}

// The service fires up to three requests: team states (triage lookup), team
// labels, then issueCreate. Route each mocked response by the operation name.
function routeLinear(overrides: { issue?: unknown } = {}) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push(body);
    if (body.query.includes("FeedbackTriageState")) {
      return linearOk({ team: { states: { nodes: [{ id: "st_triage", type: "triage" }] } } });
    }
    if (body.query.includes("FeedbackLabels")) {
      return linearOk({
        team: {
          labels: {
            nodes: [
              { id: "lbl_source", name: "source:goat" },
              { id: "lbl_bug", name: "bug" },
            ],
          },
        },
      });
    }
    if (body.query.includes("FeedbackCreateLabel")) {
      return linearOk({ issueLabelCreate: { success: false, issueLabel: null } });
    }
    return linearOk(
      overrides.issue ?? {
        issueCreate: { success: true, issue: { id: "iss_1", identifier: "opencompany-1" } },
      },
    );
  });
  return { fetchImpl, calls };
}

describe("feedback service", () => {
  beforeEach(() => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.OPENCOMPANY_FEEDBACK_LINEAR_TEAM_ID = "team_1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LINEAR_API_KEY;
    delete process.env.OPENCOMPANY_FEEDBACK_LINEAR_TEAM_ID;
    delete process.env.OPENCOMPANY_FEEDBACK_LINEAR_PROJECT_ID;
    delete process.env.OPENCOMPANY_FEEDBACK_LINEAR_LABELS;
  });

  it("creates a triaged Linear issue with the actor's identity in the description", async () => {
    const { fetchImpl, calls } = routeLinear();
    const service = createFeedbackService({ db: fakeDb(), fetch: fetchImpl });

    await service.submit(actor, { kind: "bug", message: "The board drops my column order." });

    const issueCall = calls.find((call) => call.query.includes("FeedbackCreateIssue"));
    expect(issueCall).toBeDefined();
    const input = issueCall?.variables.input as {
      teamId: string;
      title: string;
      description: string;
      stateId?: string;
      labelIds: string[];
    };
    expect(input.teamId).toBe("team_1");
    expect(input.title).toBe("[Bug] The board drops my column order.");
    expect(input.stateId).toBe("st_triage");
    expect(input.labelIds).toEqual(["lbl_source", "lbl_bug"]);
    expect(input.description).toContain("Submitted by: Ana Ng <ana@acme.example>");
    expect(input.description).toContain("Workspace: Acme (gws_1)");
    expect(input.description).toContain("Type: bug");
  });

  it("surfaces delivery failures as retryable unavailable errors with the upstream message", async () => {
    const { fetchImpl } = routeLinear({
      issue: { issueCreate: { success: false, issue: null } },
    });
    const service = createFeedbackService({ db: fakeDb(), fetch: fetchImpl });

    await expect(
      service.submit(actor, { kind: "idea", message: "Add a weekly digest email." }),
    ).rejects.toMatchObject({
      status: 503,
      code: "unavailable",
      message: "Linear did not create an issue.",
      retryable: true,
    });
  });

  it("fails clearly when the Linear credentials are not configured", async () => {
    delete process.env.LINEAR_API_KEY;
    const { fetchImpl } = routeLinear();
    const service = createFeedbackService({ db: fakeDb(), fetch: fetchImpl });

    await expect(
      service.submit(actor, { kind: "feedback", message: "Really enjoying the tasks board." }),
    ).rejects.toMatchObject({ code: "unavailable", message: "Missing LINEAR_API_KEY." });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects submissions for unknown user or workspace rows", async () => {
    const { fetchImpl } = routeLinear();
    const service = createFeedbackService({ db: fakeDb({ user: [] }), fetch: fetchImpl });

    await expect(
      service.submit(actor, { kind: "bug", message: "The sidebar flickers." }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
