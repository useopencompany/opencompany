import {
  type ConversationDto,
  ConversationPageSchema,
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  type IdentityDto,
  IdentityEnvelopeSchema,
  type IdentityUserDto,
  type IdentityWorkspaceDto,
  type WorkspaceActivationDto,
  WorkspaceActivationEnvelopeSchema,
} from "@opencompany/protocol/schemas";

const parseApiOrigin = (): string => {
  const value = process.env.EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN?.trim();
  if (!value) {
    throw new Error("EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN is required.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN must be a valid URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "EXPO_PUBLIC_OPENCOMPANY_API_ORIGIN must be an http(s) origin without credentials, a path, query parameters, or a fragment.",
    );
  }

  return url.origin;
};

const API_ORIGIN = parseApiOrigin();

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ErrorEnvelope["error"]["code"],
    readonly retryable: boolean,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface AuthenticatedApi {
  getIdentity: () => Promise<AuthenticatedIdentity>;
  syncIdentity: () => Promise<AuthenticatedIdentity>;
  switchWorkspace: (workspaceId: string) => Promise<WorkspaceActivationDto>;
  listConversations: () => Promise<ConversationDto[]>;
}

export interface AuthenticatedIdentity extends Omit<IdentityDto, "user" | "workspaces"> {
  user: IdentityUserDto;
  workspaces: IdentityWorkspaceDto[];
}

interface AuthenticatedApiOptions {
  getAccessToken: () => Promise<string>;
  onUnauthorized: () => Promise<void>;
}

const parseApiError = async (response: Response): Promise<ApiRequestError> => {
  const body = await response.json().catch(() => null);
  const parsed = ErrorEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    return new ApiRequestError(
      parsed.data.error.message,
      response.status,
      parsed.data.error.code,
      parsed.data.error.retryable,
      parsed.data.error.requestId,
    );
  }

  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  let code: ErrorEnvelope["error"]["code"] = "internal_error";
  if (response.status === 401) code = "authentication_required";
  else if (response.status === 403) code = "forbidden";
  else if (response.status === 404) code = "not_found";
  else if (response.status === 409) code = "conflict";
  else if (response.status === 429) code = "rate_limited";
  else if (response.status >= 500) code = "unavailable";

  return new ApiRequestError(
    `The opencompany API request failed with HTTP ${response.status}.`,
    response.status,
    code,
    retryable,
  );
};

export const createAuthenticatedApi = (options: AuthenticatedApiOptions): AuthenticatedApi => {
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const accessToken = await options.getAccessToken();
    let response: Response;
    try {
      response = await fetch(`${API_ORIGIN}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...init?.headers,
        },
      });
    } catch (error) {
      throw new ApiRequestError(
        error instanceof Error ? error.message : "The opencompany API could not be reached.",
        0,
        "unavailable",
        true,
      );
    }

    if (!response.ok) {
      const error = await parseApiError(response);
      if (response.status === 401) {
        await options.onUnauthorized();
      }
      throw error;
    }

    return response.json();
  };

  return {
    getIdentity: async () => {
      const body = await request("/v1/identity");
      return IdentityEnvelopeSchema.parse(body).data as AuthenticatedIdentity;
    },
    syncIdentity: async () => {
      const body = await request("/v1/identity/sync", { method: "POST" });
      return IdentityEnvelopeSchema.parse(body).data as AuthenticatedIdentity;
    },
    switchWorkspace: async (workspaceId) => {
      const body = await request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/switch`, {
        method: "POST",
      });
      return WorkspaceActivationEnvelopeSchema.parse(body).data;
    },
    listConversations: async () => {
      const body = await request("/v1/conversations?limit=25");
      return ConversationPageSchema.parse(body).data;
    },
  };
};

export const isUnauthorizedApiError = (error: unknown): boolean => {
  return error instanceof ApiRequestError && error.status === 401;
};
