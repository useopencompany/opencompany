import { validateClaudeCodeToken } from "@opencompany/agent/claude-code-token";
import type { Actor } from "@opencompany/core";
import {
  deleteClaudeCodeCredential,
  loadClaudeCodeAuthStatus,
  saveClaudeCodeCredential,
} from "@opencompany/db/claude-code-auth";
import { deleteCodexCredential, loadCodexAuthStatus } from "@opencompany/db/codex-auth";
import {
  disconnectInfisicalConnection,
  isInfisicalHost,
  loadInfisicalConnectionMetadata,
} from "@opencompany/db/infisical-auth";
import {
  clearWorkspaceCodexEngineAccount,
  designateWorkspaceCodexEngineAccount,
  loadWorkspaceCodexEngineAccount,
} from "@opencompany/db/workspace-codex-engine";
import { createLogger } from "@opencompany/observability";
import { ApiError } from "./errors";
import type { RunnerClient } from "./runner-client";

const logger = createLogger({ service: "opencompany-api", runtime: "engine-auth" });

// Follows the repo-wide injectable-db convention for services that only need a
// drizzle handle without dragging the full inferred schema type across packages.
type DbLike = any;

const INFISICAL_ADMIN_ONLY_MESSAGE = "Only workspace admins can manage Infisical.";
const CODEX_WORKSPACE_ADMIN_ONLY_MESSAGE =
  "Only workspace admins can manage the workspace Codex engine.";

export type EngineAuthConnectionStatus = {
  status: "connected" | "needs_reauth" | null;
  statusReason: string | null;
  lastValidatedAt: string | null;
  lastRotatedAt: string | null;
};

export type CodexAuthStatus = EngineAuthConnectionStatus & {
  workspaceEngine: {
    enabled: boolean;
    providerEmail: string | null;
    providerName: string | null;
    credentialStatus: "connected" | "needs_reauth" | null;
    statusReason: string | null;
    updatedAt: string | null;
  };
};

export type InfisicalAuthStatus = {
  status: "connected" | "needs_reauth" | "disconnected" | null;
  statusReason: string | null;
  accountEmail: string | null;
  host: string | null;
  lastValidatedAt: string | null;
};

export type CodexDeviceAuthFlow = {
  id: string;
  status: "pending" | "code_ready" | "completed" | "failed" | "expired";
  userCode: string | null;
  verificationUri: string | null;
  statusReason: string | null;
  expiresAt: string;
};

export type InfisicalAuthFlow = {
  id: string;
  status: "pending" | "link_ready" | "completed" | "failed" | "expired";
  loginUrl: string | null;
  statusReason: string | null;
  expiresAt: string;
};

type RunnerFlowResponse<TFlow> = { ok: boolean; flow: TFlow };

export type EngineAuthService = {
  getClaudeCodeStatus(actor: Actor): Promise<EngineAuthConnectionStatus>;
  saveClaudeCodeToken(actor: Actor, token: string): Promise<EngineAuthConnectionStatus>;
  disconnectClaudeCode(actor: Actor): Promise<void>;
  getCodexStatus(actor: Actor): Promise<CodexAuthStatus>;
  setWorkspaceCodexEngine(actor: Actor, enabled: boolean): Promise<CodexAuthStatus>;
  startCodexDeviceAuth(actor: Actor): Promise<CodexDeviceAuthFlow>;
  pollCodexDeviceAuth(actor: Actor, flowId: string): Promise<CodexDeviceAuthFlow>;
  disconnectCodex(actor: Actor): Promise<void>;
  getInfisicalStatus(actor: Actor): Promise<InfisicalAuthStatus>;
  startInfisicalAuth(actor: Actor, host: string): Promise<InfisicalAuthFlow>;
  completeInfisicalAuth(
    actor: Actor,
    flowId: string,
    browserToken: string,
  ): Promise<InfisicalAuthFlow>;
  disconnectInfisical(actor: Actor): Promise<void>;
};

export function createEngineAuthService(input: {
  db: DbLike;
  runner: RunnerClient;
}): EngineAuthService {
  const { db, runner } = input;

  async function getClaudeCodeStatus(actor: Actor) {
    const row = await loadClaudeCodeAuthStatus({ db, userWorkosId: actor.userId });
    return connectionStatusDto(row);
  }

  async function getCodexStatus(actor: Actor) {
    const [row, workspaceEngine] = await Promise.all([
      loadCodexAuthStatus({ db, userWorkosId: actor.userId }),
      loadWorkspaceCodexEngineAccount({ db, workspaceId: actor.workspaceId }),
    ]);
    return {
      ...connectionStatusDto(row),
      workspaceEngine: {
        enabled: workspaceEngine?.enabled ?? false,
        providerEmail: workspaceEngine?.providerEmail ?? null,
        providerName: workspaceEngine?.providerName ?? null,
        credentialStatus: workspaceEngine?.credentialStatus ?? null,
        statusReason: workspaceEngine?.credentialStatusReason ?? null,
        updatedAt: workspaceEngine?.updatedAt.toISOString() ?? null,
      },
    };
  }

  return {
    getClaudeCodeStatus,
    getCodexStatus,

    async setWorkspaceCodexEngine(actor, enabled) {
      requireAdmin(actor, CODEX_WORKSPACE_ADMIN_ONLY_MESSAGE);
      if (enabled) {
        const result = await designateWorkspaceCodexEngineAccount({
          db,
          workspaceId: actor.workspaceId,
          providerUserWorkosId: actor.userId,
        });
        if (!result.ok) {
          throw new ApiError(
            409,
            "conflict",
            result.reason === "codex_reauth_required"
              ? "Reconnect Codex before using your ChatGPT subscription for this workspace."
              : CODEX_WORKSPACE_ADMIN_ONLY_MESSAGE,
          );
        }
      } else {
        const result = await clearWorkspaceCodexEngineAccount({
          db,
          workspaceId: actor.workspaceId,
          requestedByWorkosId: actor.userId,
        });
        if (!result.ok) {
          throw new ApiError(403, "forbidden", CODEX_WORKSPACE_ADMIN_ONLY_MESSAGE);
        }
      }
      return getCodexStatus(actor);
    },

    async saveClaudeCodeToken(actor, token) {
      const validated = validateClaudeCodeToken(token);
      if (!validated.ok) throw new ApiError(400, "invalid_request", validated.error);
      try {
        await saveClaudeCodeCredential({
          db,
          userWorkosId: actor.userId,
          authJson: { token: validated.token },
          validatedAt: null,
        });
      } catch (error) {
        throw commandFailure(error, "Could not save the Claude Code token.", "claude_code_save");
      }
      return getClaudeCodeStatus(actor);
    },

    async disconnectClaudeCode(actor) {
      try {
        await deleteClaudeCodeCredential({ db, userWorkosId: actor.userId });
      } catch (error) {
        throw commandFailure(error, "Could not disconnect Claude Code.", "claude_code_disconnect");
      }
    },

    async startCodexDeviceAuth(actor) {
      try {
        const response = await runner.postJson<RunnerFlowResponse<CodexDeviceAuthFlow>>(
          "/internal/goat/codex-auth/device/start",
          { userWorkosId: actor.userId },
          { errorFormat: "status-text" },
        );
        return response.flow;
      } catch (error) {
        throw runnerFailure(error, "Could not start Codex authentication.", "codex_device_start");
      }
    },

    async pollCodexDeviceAuth(actor, flowId) {
      const trimmedFlowId = flowId.trim();
      if (!trimmedFlowId) {
        throw new ApiError(400, "invalid_request", "Codex auth flow is required.");
      }
      try {
        const response = await runner.postJson<RunnerFlowResponse<CodexDeviceAuthFlow>>(
          `/internal/goat/codex-auth/device/${encodeURIComponent(trimmedFlowId)}/poll`,
          { userWorkosId: actor.userId },
          { errorFormat: "status-text" },
        );
        return response.flow;
      } catch (error) {
        throw runnerFailure(error, "Could not check Codex authentication.", "codex_device_poll");
      }
    },

    async disconnectCodex(actor) {
      try {
        await deleteCodexCredential({ db, userWorkosId: actor.userId });
      } catch (error) {
        throw commandFailure(error, "Could not disconnect Codex.", "codex_disconnect");
      }
    },

    async getInfisicalStatus(actor) {
      // Member-visible on purpose: the retired settings read powered the
      // provider states for every workspace member; only mutations are
      // admin-gated.
      const connection = await loadInfisicalConnectionMetadata({
        db,
        workspaceId: actor.workspaceId,
      });
      return {
        status: connection?.status ?? null,
        statusReason: connection?.statusReason ?? null,
        accountEmail: connection?.accountEmail ?? null,
        host: connection?.host ?? null,
        lastValidatedAt: connection?.lastValidatedAt?.toISOString() ?? null,
      };
    },

    async startInfisicalAuth(actor, host) {
      requireAdmin(actor, INFISICAL_ADMIN_ONLY_MESSAGE);
      if (!isInfisicalHost(host)) {
        throw new ApiError(400, "invalid_request", "Choose a supported Infisical region.");
      }
      let flow: InfisicalAuthFlow;
      try {
        const response = await runner.postJson<RunnerFlowResponse<InfisicalAuthFlow>>(
          "/internal/goat/infisical-auth/start",
          { workspaceId: actor.workspaceId, requestedByWorkosId: actor.userId, host },
          { errorFormat: "error-message" },
        );
        flow = response.flow;
      } catch (error) {
        throw runnerFailure(error, "Could not start Infisical authentication.", "infisical_start");
      }
      // The runner builds the login link against its own configured host; a
      // mismatch means the selected region has not rolled out to it yet.
      if (infisicalFlowHost(flow) !== host) {
        throw new ApiError(
          503,
          "unavailable",
          "The selected Infisical region is still updating. Please try again in a minute.",
          true,
        );
      }
      return flow;
    },

    async completeInfisicalAuth(actor, flowId, browserToken) {
      requireAdmin(actor, INFISICAL_ADMIN_ONLY_MESSAGE);
      const trimmedFlowId = flowId.trim();
      const trimmedToken = browserToken.trim();
      if (!trimmedFlowId || !trimmedToken) {
        throw new ApiError(400, "invalid_request", "Paste the browser token from Infisical.");
      }
      try {
        const response = await runner.postJson<RunnerFlowResponse<InfisicalAuthFlow>>(
          `/internal/goat/infisical-auth/${encodeURIComponent(trimmedFlowId)}/complete`,
          {
            workspaceId: actor.workspaceId,
            requestedByWorkosId: actor.userId,
            browserToken: trimmedToken,
          },
          { errorFormat: "error-message" },
        );
        return response.flow;
      } catch (error) {
        throw runnerFailure(
          error,
          "Could not complete Infisical authentication.",
          "infisical_complete",
        );
      }
    },

    async disconnectInfisical(actor) {
      requireAdmin(actor, INFISICAL_ADMIN_ONLY_MESSAGE);
      try {
        await disconnectInfisicalConnection({ db, workspaceId: actor.workspaceId });
      } catch (error) {
        throw commandFailure(error, "Could not disconnect Infisical.", "infisical_disconnect");
      }
    },
  };
}

function connectionStatusDto(
  row: {
    status: "connected" | "needs_reauth";
    statusReason: string | null;
    lastValidatedAt: Date | null;
    lastRotatedAt: Date | null;
  } | null,
): EngineAuthConnectionStatus {
  return {
    status: row?.status ?? null,
    statusReason: row?.statusReason ?? null,
    lastValidatedAt: row?.lastValidatedAt?.toISOString() ?? null,
    lastRotatedAt: row?.lastRotatedAt?.toISOString() ?? null,
  };
}

function infisicalFlowHost(flow: InfisicalAuthFlow) {
  if (!flow.loginUrl) return null;
  try {
    return new URL(flow.loginUrl).origin;
  } catch {
    return null;
  }
}

function requireAdmin(actor: Actor, message: string) {
  if (actor.role !== "admin") throw new ApiError(403, "forbidden", message);
}

// The retired actions surfaced runner failure messages to the user verbatim
// ("Runner is not configured.", "Runner request failed with 502: ..."). Keep
// that copy so the settings panel reads exactly as before the cutover. Never
// logs token material.
function runnerFailure(error: unknown, fallback: string, command: string): ApiError {
  if (error instanceof ApiError) return error;
  logger.error("Engine auth runner call failed", {
    event: "opencompany.api_engine_auth_runner_call_failed",
    command,
    error_name: error instanceof Error ? error.name : typeof error,
    error_message: error instanceof Error ? error.message : String(error),
  });
  return new ApiError(503, "unavailable", error instanceof Error ? error.message : fallback, true);
}

// Unexpected persistence failures keep a deterministic human-readable message
// instead of degrading to a generic internal error, mirroring 5a1/5a2.
function commandFailure(error: unknown, message: string, command: string): ApiError {
  if (error instanceof ApiError) return error;
  logger.error("Engine auth command failed", {
    event: "opencompany.api_engine_auth_command_failed",
    command,
    error_name: error instanceof Error ? error.name : typeof error,
    error_message: error instanceof Error ? error.message : String(error),
  });
  return new ApiError(503, "unavailable", message, true);
}
