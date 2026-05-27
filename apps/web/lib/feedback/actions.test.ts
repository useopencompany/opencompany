import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentWorkspace } from "@/lib/auth";
import { submitFeedback } from "./actions";

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspace: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

const getCurrentWorkspaceMock = vi.mocked(getCurrentWorkspace);
const getDbMock = vi.mocked(getDb);

function mockSessionLookup(rows: Array<{ id: string }>) {
  const builder = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    limit: vi.fn(() => Promise.resolve(rows)),
  };

  getDbMock.mockReturnValue({
    select: vi.fn(() => builder),
  } as unknown as ReturnType<typeof getDb>);
}

function linearResponse(data: unknown) {
  return {
    ok: true,
    json: async () => ({ data }),
  } as Response;
}

function labelsResponse() {
  return linearResponse({
    team: {
      labels: {
        nodes: [
          { id: "lbl_feedback", name: "feedback" },
          { id: "lbl_source_app", name: "source:app" },
          { id: "lbl_bug", name: "bug" },
        ],
      },
    },
  });
}

function issueCreateResponse() {
  return linearResponse({
    issueCreate: {
      success: true,
      issue: { id: "lin_123", identifier: "FEED-123" },
    },
  });
}

function issueCreateInput() {
  const issueCall = vi.mocked(fetch).mock.calls.at(-1);
  expect(issueCall).toBeDefined();
  const body = JSON.parse(String(issueCall?.[1]?.body)) as {
    variables: { input: { description: string } };
  };

  return body.variables.input;
}

describe("submitFeedback", () => {
  beforeEach(() => {
    process.env.LINEAR_API_KEY = "lin_test";
    process.env.LINEAR_TEAM_ID = "team_123";
    delete process.env.LINEAR_FEEDBACK_PROJECT_ID;
    delete process.env.LINEAR_FEEDBACK_LABELS;

    getCurrentWorkspaceMock.mockResolvedValue({
      authUser: {
        id: "workos_123",
        email: "lee@example.com",
        firstName: "Lee",
        lastName: "Chen",
      },
      user: { id: "usr_123" },
      workspace: { id: "wks_123", name: "Acme" },
      role: "member",
      isNewUser: false,
    } as Awaited<ReturnType<typeof getCurrentWorkspace>>);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(labelsResponse()));
  });

  it("includes the verified session id in the Linear issue description", async () => {
    mockSessionLookup([{ id: "ses_123" }]);
    vi.mocked(fetch).mockResolvedValueOnce(issueCreateResponse());

    const formData = new FormData();
    formData.set("kind", "bug");
    formData.set("message", "The session froze.");
    formData.set("sessionId", "ses_123");

    await expect(submitFeedback(null, formData)).resolves.toEqual({ ok: true });

    expect(issueCreateInput().description).toContain("Session ID: ses_123");
  });

  it("omits an unverified session id from the Linear issue description", async () => {
    mockSessionLookup([]);
    vi.mocked(fetch).mockResolvedValueOnce(issueCreateResponse());

    const formData = new FormData();
    formData.set("kind", "bug");
    formData.set("message", "The session froze.");
    formData.set("sessionId", "ses_other");

    await expect(submitFeedback(null, formData)).resolves.toEqual({ ok: true });

    expect(issueCreateInput().description).not.toContain("Session ID:");
  });
});
