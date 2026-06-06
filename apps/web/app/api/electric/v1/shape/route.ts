import { currentWorkspace } from "@/lib/auth";

/**
 * Auth proxy in front of the ElectricSQL sync service.
 *
 * The browser's Electric collections request shapes from THIS route, never from
 * Electric directly. We authenticate the caller, then set `table`/`columns`/
 * `where` server-side from the session — clients cannot choose their own table
 * or widen the WHERE clause. Only Electric's protocol cursor params are
 * forwarded from the client.
 *
 * Pattern: https://electric.ax/docs/guides/auth
 */

// Electric protocol params the client controls (cursor/long-poll). Everything
// else (table, where, columns, params) is set by us.
const ELECTRIC_CURSOR_PARAMS = ["offset", "handle", "live", "cursor", "replica"] as const;

type ShapeScope = {
  table: string;
  columns?: string[];
  // Returns the WHERE clause + positional params, or null to deny.
  where: (ctx: {
    workspaceId: string;
    userId: string;
  }) => { clause: string; params: string[] } | null;
};

// Allow-list: maps the client's requested table to its trusted server-side scope.
const SHAPE_SCOPES: Record<string, ShapeScope> = {
  agents: {
    table: "agents",
    // Workspace-wide agents only. Private/personal agents (user_id set, e.g. the /personal
    // experiment agent) are deliberately excluded from the synced collection so they never
    // surface in workspace agent pickers/lists. /personal loads its agent via server fetch.
    where: ({ workspaceId }) => ({
      clause: `"workspace_id" = $1 AND "user_id" IS NULL`,
      params: [workspaceId],
    }),
  },
  agent_sessions: {
    table: "agent_sessions",
    where: ({ workspaceId, userId }) => ({
      clause: `"workspace_id" = $1 AND "user_id" = $2 AND "source" = 'user' AND "archived_at" IS NULL`,
      params: [workspaceId, userId],
    }),
  },
  session_stars: {
    table: "session_stars",
    where: ({ userId }) => ({ clause: `"user_id" = $1`, params: [userId] }),
  },
};

function electricBaseUrl(): string | null {
  return process.env.ELECTRIC_URL?.replace(/\/+$/, "") ?? null;
}

export async function GET(request: Request): Promise<Response> {
  const electricUrl = electricBaseUrl();
  if (!electricUrl) {
    return new Response("Electric sync is not configured.", { status: 503 });
  }

  const context = await currentWorkspace({ optional: true, skipOnboarding: true });
  if (!context) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { user, workspace } = context;

  const requestUrl = new URL(request.url);
  const requestedTable = requestUrl.searchParams.get("table");
  const scope = requestedTable ? SHAPE_SCOPES[requestedTable] : undefined;
  if (!scope) {
    return new Response("Unknown or unauthorized shape.", { status: 403 });
  }

  const resolved = scope.where({
    workspaceId: workspace.id,
    userId: user.id,
  });
  if (!resolved) {
    return new Response("Forbidden", { status: 403 });
  }

  const originUrl = new URL(`${electricUrl}/v1/shape`);
  // Forward only Electric's cursor/long-poll params from the client.
  for (const key of ELECTRIC_CURSOR_PARAMS) {
    const value = requestUrl.searchParams.get(key);
    if (value !== null) originUrl.searchParams.set(key, value);
  }
  // Trusted, server-set shape definition.
  originUrl.searchParams.set("table", scope.table);
  if (scope.columns) originUrl.searchParams.set("columns", scope.columns.join(","));
  originUrl.searchParams.set("where", resolved.clause);
  resolved.params.forEach((param, index) => {
    originUrl.searchParams.set(`params[${index + 1}]`, param);
  });
  // Electric Cloud source credentials, if used.
  if (process.env.ELECTRIC_SOURCE_ID) {
    originUrl.searchParams.set("source_id", process.env.ELECTRIC_SOURCE_ID);
  }
  if (process.env.ELECTRIC_SOURCE_SECRET) {
    originUrl.searchParams.set("secret", process.env.ELECTRIC_SOURCE_SECRET);
  }

  const response = await fetch(originUrl, {
    headers: process.env.ELECTRIC_SOURCE_SECRET
      ? {}
      : {
          ...(process.env.ELECTRIC_TOKEN
            ? { Authorization: `Bearer ${process.env.ELECTRIC_TOKEN}` }
            : {}),
        },
  });

  // Electric responses are gzipped/length-bound for its own origin; strip those
  // hop-by-hop headers so the browser decodes our re-emitted body correctly.
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  // Cached shape responses must vary by auth so one user can't read another's.
  headers.set("Vary", "Cookie");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
