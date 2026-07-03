const ELECTRIC_CURSOR_PARAMS = ["offset", "handle", "live", "cursor", "replica"] as const;

const SHAPE_SCOPES = {
  tasks: {
    table: "goat.tasks",
    where: (userWorkosId: string) => ({
      clause: `"user_workos_id" = $1`,
      params: [userWorkosId],
    }),
  },
  "goat.tasks": {
    table: "goat.tasks",
    where: (userWorkosId: string) => ({
      clause: `"user_workos_id" = $1`,
      params: [userWorkosId],
    }),
  },
  task_messages: {
    table: "goat.task_messages",
    where: scopedTaskWhere,
  },
  "goat.task_messages": {
    table: "goat.task_messages",
    where: scopedTaskWhere,
  },
  task_events: {
    table: "goat.task_events",
    where: scopedTaskWhere,
  },
  "goat.task_events": {
    table: "goat.task_events",
    where: scopedTaskWhere,
  },
  task_model_usage: {
    table: "goat.task_model_usage",
    where: scopedTaskWhere,
  },
  "goat.task_model_usage": {
    table: "goat.task_model_usage",
    where: scopedTaskWhere,
  },
  task_tool_usage: {
    table: "goat.task_tool_usage",
    where: scopedTaskWhere,
  },
  "goat.task_tool_usage": {
    table: "goat.task_tool_usage",
    where: scopedTaskWhere,
  },
  task_sandbox_usage: {
    table: "goat.task_sandbox_usage",
    where: scopedTaskWhere,
  },
  "goat.task_sandbox_usage": {
    table: "goat.task_sandbox_usage",
    where: scopedTaskWhere,
  },
  integrations: {
    table: "goat.integrations",
    where: scopedUserWhere,
  },
  "goat.integrations": {
    table: "goat.integrations",
    where: scopedUserWhere,
  },
  brain_folders: {
    table: "goat.brain_folders",
    where: scopedUserWhere,
  },
  "goat.brain_folders": {
    table: "goat.brain_folders",
    where: scopedUserWhere,
  },
  brain_documents: {
    table: "goat.brain_documents",
    where: scopedUserWhere,
  },
  "goat.brain_documents": {
    table: "goat.brain_documents",
    where: scopedUserWhere,
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
  sourceId?: string | null | undefined;
  sourceSecret?: string | null | undefined;
  electricSecret?: string | null | undefined;
}) {
  const requestedTable = input.requestUrl.searchParams.get("table");
  const scope = requestedTable ? SHAPE_SCOPES[requestedTable as keyof typeof SHAPE_SCOPES] : null;
  if (!scope) return null;

  const originUrl = new URL(`${input.electricUrl.replace(/\/+$/, "")}/v1/shape`);
  for (const key of ELECTRIC_CURSOR_PARAMS) {
    const value = input.requestUrl.searchParams.get(key);
    if (value !== null) originUrl.searchParams.set(key, value);
  }

  const resolved = scope.where(input.userWorkosId, input.requestUrl);
  originUrl.searchParams.set("table", scope.table);
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

function scopedTaskWhere(userWorkosId: string, requestUrl: URL) {
  const taskId = requestUrl.searchParams.get("task_id")?.trim();
  if (!taskId) {
    return {
      clause: `"user_workos_id" = $1`,
      params: [userWorkosId],
    };
  }
  return {
    clause: `"user_workos_id" = $1 AND "task_id" = $2`,
    params: [userWorkosId, taskId],
  };
}

function scopedUserWhere(userWorkosId: string) {
  return {
    clause: `"user_workos_id" = $1`,
    params: [userWorkosId],
  };
}
