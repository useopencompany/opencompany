type ShapeWhere = {
  clause: string;
  params: string[];
};

type ShapeWhereContext = {
  workspaceId?: string | null | undefined;
};

const ELECTRIC_CURSOR_PARAMS = ["offset", "handle", "live", "cursor", "replica"] as const;

const SHAPE_SCOPES = {
  integrations: {
    table: "goat.integrations",
    where: scopedIntegrationsWhere,
  },
  "goat.integrations": {
    table: "goat.integrations",
    where: scopedIntegrationsWhere,
  },
} as const;

export function goatElectricBaseUrl() {
  return process.env.ELECTRIC_URL?.replace(/\/+$/, "") ?? null;
}

export function hasInvalidElectricCloudSecretPair(input: {
  sourceId?: string | null | undefined;
  sourceSecret?: string | null | undefined;
}) {
  return Boolean(input.sourceId) !== Boolean(input.sourceSecret);
}

export function buildGoatElectricOriginUrl(input: {
  electricUrl: string;
  requestUrl: URL;
  userWorkosId: string;
  workspaceId?: string | null | undefined;
  sourceId?: string | null | undefined;
  sourceSecret?: string | null | undefined;
  electricSecret?: string | null | undefined;
}) {
  const requestedTable = input.requestUrl.searchParams.get("table");
  const scope: {
    table: string;
    where: (userWorkosId: string, requestUrl: URL, context: ShapeWhereContext) => ShapeWhere | null;
    columns?: readonly string[];
  } | null = requestedTable
    ? (SHAPE_SCOPES[requestedTable as keyof typeof SHAPE_SCOPES] ?? null)
    : null;
  if (!scope) return null;

  const originUrl = new URL(`${input.electricUrl.replace(/\/+$/, "")}/v1/shape`);
  for (const key of ELECTRIC_CURSOR_PARAMS) {
    const value = input.requestUrl.searchParams.get(key);
    if (value !== null) originUrl.searchParams.set(key, value);
  }

  const resolved = scope.where(input.userWorkosId, input.requestUrl, {
    workspaceId: input.workspaceId,
  });
  if (!resolved) return null;

  originUrl.searchParams.set("table", scope.table);
  if (scope.columns) originUrl.searchParams.set("columns", scope.columns.join(","));
  originUrl.searchParams.set("where", resolved.clause);
  resolved.params.forEach((param, index) => {
    originUrl.searchParams.set(`params[${index + 1}]`, param);
  });

  if (input.sourceId && input.sourceSecret) {
    originUrl.searchParams.set("source_id", input.sourceId);
    originUrl.searchParams.set("secret", input.sourceSecret);
  } else if (input.electricSecret) {
    originUrl.searchParams.set("secret", input.electricSecret);
  }

  return originUrl;
}

// Integrations are visible when personally owned OR owned by the active
// workspace (github/jamie plumbing every member can see the status of).
function scopedIntegrationsWhere(
  userWorkosId: string,
  _requestUrl: URL,
  context: ShapeWhereContext,
): ShapeWhere {
  if (!context.workspaceId) {
    return {
      clause: `"user_workos_id" = $1 AND "workspace_id" IS NULL`,
      params: [userWorkosId],
    };
  }
  return {
    clause: `("user_workos_id" = $1 AND "workspace_id" IS NULL) OR "workspace_id" = $2`,
    params: [userWorkosId, context.workspaceId],
  };
}
