import type { SentryConnection } from "@opencompany/db/sentry";
import { afterEach, expect, it, vi } from "vitest";
import {
  executeSentryTool,
  filterSentryTrace,
  type SentryToolName,
  sentryToolMode,
} from "./sentry";

vi.mock("../integrations/expiring-oauth-access-token", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getExpiringOAuthAccessToken: vi.fn(async () => "fixture-token"),
}));
const connection = {
  integrationId: "connection",
  workspaceId: "workspace",
  organizationSlug: "acme",
  region: "eu",
  selectedProjectIds: ["1"],
  capabilityModes: {},
  toolModes: {},
} as SentryConnection;
afterEach(() => vi.unstubAllGlobals());
const projectTools: SentryToolName[] = [
  "list_assignees",
  "search_issues",
  "get_release",
  "list_release_commits",
  "search_logs",
  "search_spans",
];
it.each(projectTools)("%s rejects inaccessible project IDs before fetching", async (name) => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const params = {
    projectId: "2",
    ...(name.includes("release") ? { version: "v1" } : {}),
    ...(["search_logs", "search_spans"].includes(name)
      ? { start: "2026-10-03T10:00:00Z", end: "2026-10-03T11:00:00Z" }
      : {}),
  };
  await expect(executeSentryTool(connection, name, params)).rejects.toThrow("not selected");
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  "get_issue",
  "list_occurrences",
  "get_occurrence",
  "assign_issue",
  "unassign_issue",
  "resolve_issue",
  "archive_issue",
] as SentryToolName[])(
  "%s refuses foreign issue IDs before reading occurrences or updating",
  async (name) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        if (!String(url).endsWith("organizations/acme/issues/42/") || init.method !== "GET")
          throw new Error("A foreign issue caused an unauthorized follow-up request");
        return Response.json({ id: "42", title: "foreign", project: { id: "2", slug: "secret" } });
      }),
    );
    await expect(
      executeSentryTool(connection, name, {
        issueId: "42",
        ...(name === "get_occurrence" ? { eventId: "oldest" } : {}),
        ...(name === "assign_issue" ? { assignee: "user:7" } : {}),
      }),
    ).rejects.toThrow("inaccessible project");
  },
);
it("keeps explicit project restrictions when a query injects OR project conditions and returns pagination", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      if (url.host !== "de.sentry.io" || url.searchParams.get("project") !== "1")
        return new Response(null, { status: 403 });
      return Response.json(
        [
          { id: "42", title: "Allowed", project: { id: "1", slug: "web" } },
          { id: "43", title: "Foreign", project: { id: "2", slug: "secret" } },
        ],
        {
          headers: {
            Link: '<https://de.sentry.io/api/0/organizations/acme/issues/?cursor=page2>; rel="next"; results="true"; cursor="page2"',
          },
        },
      );
    }),
  );
  await expect(
    executeSentryTool(connection, "search_issues", {
      projectId: "1",
      query: "is:unresolved OR project:secret",
    }),
  ).resolves.toMatchObject({ data: [{ id: "42" }], nextCursor: "page2", unavailable: false });
});
it("removes foreign trace nodes recursively, including errors and occurrences", () => {
  expect(
    filterSentryTrace(
      [
        {
          project_id: 1,
          children: [{ project_id: 2, children: [{ project_id: 1, secret: true }] }],
          errors: [{ project_id: 2 }],
          occurrences: [{ projectId: "1", event: "safe" }],
        },
        { project_id: 2 },
      ],
      new Set(["1"]),
    ),
  ).toEqual([
    { project_id: 1, children: [], errors: [], occurrences: [{ projectId: "1", event: "safe" }] },
  ]);
});
it("distinguishes unavailable logs from an empty result and bounds returned fields", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 403 })),
  );
  const params = { projectId: "1", start: "2026-10-03T10:00:00Z", end: "2026-10-03T11:00:00Z" };
  await expect(executeSentryTool(connection, "search_logs", params)).resolves.toMatchObject({
    unavailable: true,
    reason: "missing permissions",
    data: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: [] })),
  );
  await expect(executeSentryTool(connection, "search_logs", params)).resolves.toMatchObject({
    unavailable: false,
    data: { data: [] },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: [{ "project.id": 1, message: "x".repeat(10000) }] })),
  );
  await expect(executeSentryTool(connection, "search_logs", params)).resolves.toMatchObject({
    truncated: true,
  });
});
it("defaults reads to on and writes to ask, honoring admin overrides per tool", () => {
  expect(sentryToolMode(connection, "get_issue")).toBe("on");
  expect(sentryToolMode(connection, "resolve_issue")).toBe("ask");
  expect(
    sentryToolMode(
      { ...connection, capabilityModes: { write: "on" }, toolModes: { archive_issue: "off" } },
      "archive_issue",
    ),
  ).toBe("off");
});
it("uses normal resolution and permanent archiving without arbitrary status parameters", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: URL, init: RequestInit) => {
      if (init.method === "GET")
        return Response.json({ id: "42", title: "Allowed", project: { id: "1", slug: "web" } });
      const data = JSON.parse(String(init.body));
      if (
        data.status === "resolved" ||
        (data.status === "ignored" && data.substatus === "archived_forever")
      )
        return Response.json(data);
      return new Response(null, { status: 400 });
    }),
  );
  await expect(
    executeSentryTool(connection, "resolve_issue", { issueId: "42" }),
  ).resolves.toMatchObject({ data: { status: "resolved" } });
  await expect(
    executeSentryTool(connection, "archive_issue", { issueId: "42" }),
  ).resolves.toMatchObject({ data: { status: "ignored", substatus: "archived_forever" } });
});

it("lists only selected projects and carries the cursor to the next selected page", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      expect(url.pathname).toBe("/api/0/projects/acme/1/");
      return Response.json({ id: "1", slug: "web", name: "Web" });
    }),
  );
  await expect(
    executeSentryTool({ ...connection, selectedProjectIds: ["1", "3"] }, "list_projects", {
      limit: 1,
    }),
  ).resolves.toMatchObject({ data: [{ id: "1" }], nextCursor: "1" });
});
it("uses the selected project's release commits endpoint", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      expect(url.pathname).toBe("/api/0/projects/acme/1/releases/v1/commits/");
      return Response.json([{ id: "commit", message: "Fix" }]);
    }),
  );
  await expect(
    executeSentryTool(connection, "list_release_commits", { projectId: "1", version: "v1" }),
  ).resolves.toMatchObject({ data: [{ id: "commit" }] });
});
it("drops trace nodes whose only project identity is an inaccessible slug", () => {
  expect(
    filterSentryTrace(
      {
        children: [
          { project_slug: "secret", span_id: "a", description: "foreign" },
          { project_id: 1, span_id: "b" },
        ],
      },
      new Set(["1"]),
    ),
  ).toEqual({ children: [{ project_id: 1, span_id: "b" }] });
});
function assigneePages(pages: Record<string, unknown[]>) {
  return vi.fn(async (url: URL, init: RequestInit) => {
    if (String(url).endsWith("organizations/acme/issues/42/") && init.method === "GET")
      return Response.json({ id: "42", title: "Error", project: { id: "1", slug: "web" } });
    if (init.method === "PUT") return Response.json({ id: "42" });
    const cursor = url.searchParams.get("cursor") ?? "first";
    const next = cursor === "first" ? "page2" : null;
    return Response.json(pages[cursor] ?? [], {
      headers: next
        ? {
            Link: `<${url.origin}${url.pathname}?cursor=${next}>; rel="next"; results="true"; cursor="${next}"`,
          }
        : {},
    });
  });
}
it("lists assignees as the exact values assign_issue accepts, skipping pending invitations", async () => {
  vi.stubGlobal(
    "fetch",
    assigneePages({
      first: [
        { email: "ada@acme.test", user: { id: "7", name: "Ada" } },
        { email: "invited@acme.test", user: null },
      ],
    }),
  );
  await expect(
    executeSentryTool(connection, "list_assignees", { projectId: "1" }),
  ).resolves.toMatchObject({
    data: [{ assignee: "user:7", kind: "user", name: "Ada" }],
    nextCursor: "page2",
  });
});
it("assigns a team discovered on a later page and rejects one on no page", async () => {
  const fetcher = assigneePages({ first: [{ id: "3", slug: "web" }], page2: [{ id: "9" }] });
  vi.stubGlobal("fetch", fetcher);
  await expect(
    executeSentryTool(connection, "assign_issue", { issueId: "42", assignee: "team:9" }),
  ).resolves.toMatchObject({ unavailable: false });
  const update = fetcher.mock.calls.find(([, init]) => init.method === "PUT")!;
  expect(JSON.parse(String(update[1].body))).toEqual({ assignedTo: "team:9" });

  fetcher.mockClear();
  await expect(
    executeSentryTool(connection, "assign_issue", { issueId: "42", assignee: "team:10" }),
  ).rejects.toThrow("not an eligible member or team");
  expect(fetcher.mock.calls.some(([, init]) => init.method === "PUT")).toBe(false);
});
