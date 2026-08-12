import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getHeadlessWorkflow,
  listHeadlessTaskSchedules,
  listHeadlessWorkflows,
} from "./headless-automation-server";

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

const meta = { apiVersion: "v1", protocolVersion: "1.0.0" };
const workflow = {
  id: "workflow_1",
  slug: "weekly-research",
  name: "Weekly research",
  description: "Track changes",
  steps: [],
  status: "draft",
  trigger: { type: "manual" },
  version: 1,
  archivedAt: null,
  createdAt: "2026-08-11T09:00:00.000Z",
  updatedAt: "2026-08-11T09:00:00.000Z",
};
const schedule = {
  id: "schedule_1",
  name: "Daily research",
  sourceDescription: "Every morning",
  cron: "0 9 * * *",
  timezone: "UTC",
  prompt: "Research changes.",
  enabled: true,
  lastRunAt: null,
  nextRunAt: "2026-08-12T09:00:00.000Z",
  version: 1,
  createdAt: "2026-08-11T09:00:00.000Z",
  updatedAt: "2026-08-11T09:00:00.000Z",
};

describe("server automation reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOAT_API_ORIGIN", "https://api.example.test");
    vi.mocked(headers).mockResolvedValue(
      new Headers({ Cookie: "wos-session=session", Authorization: "Bearer token" }) as never,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("paginates typed Workflow reads with the incoming actor credentials and no cache", async () => {
    const requests: Array<{ request: Request; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push({ request, ...(init ? { init } : {}) });
        const cursor = new URL(request.url).searchParams.get("cursor");
        return Response.json({
          data: [{ ...workflow, id: cursor ? "workflow_2" : workflow.id }],
          nextCursor: cursor ? null : "page_2",
          meta,
        });
      }),
    );

    await expect(listHeadlessWorkflows()).resolves.toHaveLength(2);

    expect(requests.map(({ request }) => new URL(request.url).search)).toEqual([
      "?limit=100",
      "?limit=100&cursor=page_2",
    ]);
    expect(requests[0]?.request.headers.get("cookie")).toBe("wos-session=session");
    expect(requests[0]?.request.headers.get("authorization")).toBe("Bearer token");
    expect(requests[0]?.init?.cache).toBe("no-store");
  });

  it("returns null only for a canonical not-found response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(getHeadlessWorkflow("missing-workflow")).resolves.toBeNull();
  });

  it("loads the initial recurring Task snapshot through the typed API", async () => {
    let upstream: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        upstream = input instanceof Request ? input : new Request(input, init);
        return Response.json({ data: [schedule], nextCursor: null, meta });
      }),
    );

    await expect(listHeadlessTaskSchedules()).resolves.toEqual([schedule]);
    expect(new URL((upstream as unknown as Request).url).pathname).toBe("/v1/schedules");
  });

  it("surfaces canonical API failures with their request id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "forbidden",
              message: "Tasks & Workflows is disabled for this actor.",
              requestId: "request_1",
              retryable: false,
            },
            meta,
          },
          { status: 403 },
        ),
      ),
    );

    await expect(listHeadlessWorkflows()).rejects.toThrow(
      "Tasks & Workflows is disabled for this actor. (request request_1)",
    );
  });
});
