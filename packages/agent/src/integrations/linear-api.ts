const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_API_TIMEOUT_MS = 10_000;

export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "LinearApiError";
  }
}

export function isLinearAuthenticationError(error: unknown) {
  return error instanceof LinearApiError && (error.status === 401 || error.status === 403);
}

export async function linearGraphqlRequest<T>(input: {
  token: string;
  query: string;
  variables?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.token}`,
    },
    body: JSON.stringify({
      query: input.query,
      ...(input.variables ? { variables: input.variables } : {}),
    }),
    signal: input.signal ?? AbortSignal.timeout(LINEAR_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new LinearApiError(
      `Linear GraphQL request failed with ${response.status}.`,
      response.status,
    );
  }

  const result = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (result.errors?.length) {
    throw new LinearApiError(
      `Linear GraphQL returned ${result.errors[0]?.message ?? "an unknown error"}.`,
    );
  }
  if (!result.data) throw new LinearApiError("Linear GraphQL returned no data.");
  return result.data;
}
