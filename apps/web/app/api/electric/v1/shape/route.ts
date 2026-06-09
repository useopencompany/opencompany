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
    where: ({ workspaceId }) => ({ clause: `"workspace_id" = $1`, params: [workspaceId] }),
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
  // Authenticate to Electric, server-side only. Mutually-exclusive modes:
  //  - Electric Cloud: source_id + secret (the source's secret).
  //  - Self-hosted secure mode: ELECTRIC_SECRET passed as the `secret` query param.
  //    Electric is secure-by-default and its HTTP API is public unless this is set;
  //    the secret is injected here and never exposed to the browser (per the Electric
  //    auth-proxy guidance, used for preview environments — see issue #351).
  //  - Legacy/custom gatekeeper: ELECTRIC_TOKEN bearer header.
  const sourceId = process.env.ELECTRIC_SOURCE_ID?.trim();
  const sourceSecret = process.env.ELECTRIC_SOURCE_SECRET?.trim();
  const electricSecret = process.env.ELECTRIC_SECRET?.trim();
  // Electric Cloud needs source_id and secret together; one without the other is
  // a misconfiguration that would send an invalid upstream auth combo, so fail
  // loudly instead of silently falling back to a self-hosted secret.
  if (Boolean(sourceId) !== Boolean(sourceSecret)) {
    return new Response("Electric sync is misconfigured.", { status: 503 });
  }
  if (sourceId && sourceSecret) {
    originUrl.searchParams.set("source_id", sourceId);
    originUrl.searchParams.set("secret", sourceSecret);
  } else if (electricSecret) {
    originUrl.searchParams.set("secret", electricSecret);
  }

  const usesQuerySecret = Boolean((sourceId && sourceSecret) || electricSecret);
  const response = await fetch(originUrl, {
    headers:
      !usesQuerySecret && process.env.ELECTRIC_TOKEN
        ? { Authorization: `Bearer ${process.env.ELECTRIC_TOKEN}` }
        : {},
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
