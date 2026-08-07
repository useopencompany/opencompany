import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentUser } from "@/lib/auth";
import { submitFeedback } from "./actions";

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(),
}));

const currentUserMock = vi.mocked(currentUser);

function authContext() {
  return {
    authUser: { email: "ana@acme.com", firstName: "Ana", lastName: "Ng" },
    workspace: { id: "gws_1", name: "Acme" },
  } as unknown as Awaited<ReturnType<typeof currentUser>>;
}

function linearOk<T>(data: T) {
  return { ok: true, json: async () => ({ data }) } as unknown as Response;
}

// The action fires up to three requests: team states (triage lookup), team
// labels, then issueCreate. Route each mocked response by the operation name.
function routeLinear(overrides: { issue?: unknown } = {}) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string };
    if (body.query.includes("FeedbackTriageState")) {
      return linearOk({ team: { states: { nodes: [{ id: "st_triage", type: "triage" }] } } });
    }
    if (body.query.includes("FeedbackLabels")) {
      return linearOk({ team: { labels: { nodes: [] } } });
    }
    if (body.query.includes("FeedbackCreateLabel")) {
      return linearOk({ issueLabelCreate: { success: false, issueLabel: null } });
    }
    return linearOk(
      overrides.issue ?? {
        issueCreate: { success: true, issue: { id: "iss_1", identifier: "GOAT-1" } },
      },
    );
  });
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("submitFeedback", () => {
  beforeEach(() => {
    currentUserMock.mockResolvedValue(authContext());
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.FEEDBACK_LINEAR_TEAM_ID = "team_1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.LINEAR_API_KEY;
    delete process.env.FEEDBACK_LINEAR_TEAM_ID;
  });

  it("rejects an empty message", async () => {
    const result = await submitFeedback(null, form({ kind: "bug", message: "  " }));
    expect(result).toEqual({ ok: false, error: "Enter a bit more detail." });
  });

  it("rejects an overly long message", async () => {
    const result = await submitFeedback(
      null,
      form({ kind: "feedback", message: "x".repeat(4001) }),
    );
    expect(result).toEqual({ ok: false, error: "Keep feedback under 4,000 characters." });
  });

  it("creates a triage issue with source + kind labels", async () => {
    const fetchMock = routeLinear();
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitFeedback(
      null,
      form({ kind: "bug", message: "Search returns stale results" }),
    );

    expect(result).toEqual({ ok: true });

    const issueCall = fetchMock.mock.calls.find(([, init]) =>
      String((init as RequestInit).body).includes("FeedbackCreateIssue"),
    );
    expect(issueCall).toBeDefined();
    const input = JSON.parse(String((issueCall?.[1] as RequestInit).body)).variables.input;
    expect(input.teamId).toBe("team_1");
    expect(input.title).toBe("[Bug] Search returns stale results");
    expect(input.stateId).toBe("st_triage");
    expect(input.description).toContain("Submitted from: Goat app");
    expect(input.description).toContain("Ana Ng <ana@acme.com>");
    expect(input.description).toContain("Workspace: Acme (gws_1)");
  });

  it("defaults an unknown kind to feedback", async () => {
    vi.stubGlobal("fetch", routeLinear());
    const result = await submitFeedback(null, form({ kind: "nonsense", message: "Nice tool" }));
    expect(result).toEqual({ ok: true });
  });

  it("surfaces a missing API key as an error", async () => {
    delete process.env.LINEAR_API_KEY;
    const result = await submitFeedback(null, form({ kind: "idea", message: "Add dark mode" }));
    expect(result).toEqual({ ok: false, error: "Missing LINEAR_API_KEY." });
  });

  it("returns an error when Linear reports failure", async () => {
    vi.stubGlobal(
      "fetch",
      routeLinear({ issue: { issueCreate: { success: false, issue: null } } }),
    );
    const result = await submitFeedback(
      null,
      form({ kind: "feedback", message: "Something broke" }),
    );
    expect(result).toEqual({ ok: false, error: "Linear did not create an issue." });
  });
});
