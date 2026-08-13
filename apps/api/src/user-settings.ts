import { normalizeScheduleTimezone } from "@opencompany/agent-runtime";
import type { Actor } from "@opencompany/core";
import { type GoatMcpClient, type GoatTaskViewMode, goatUsers } from "@opencompany/db/goat-schema";
import { eq } from "drizzle-orm";
import { ApiError } from "./errors";

// Follows the repo-wide injectable-db convention for services that only need a
// drizzle handle without dragging the full inferred schema type across packages.
type DbLike = any;

export type UserPreferenceSet = {
  timezone: string;
  taskSpawningEnabled: boolean;
  wikiEnabled: boolean;
  taskViewMode: GoatTaskViewMode;
  imessageEnabled: boolean;
  autoModelRoutingEnabled: boolean;
};

export type UpdateUserPreferencesCommand = Partial<UserPreferenceSet>;

export type McpSetupStatus = {
  preferredClient: GoatMcpClient | null;
  complete: boolean;
  completedAt: Date | null;
};

export type UserSettingsService = {
  updatePreferences(
    actor: Actor,
    command: UpdateUserPreferencesCommand,
  ): Promise<UserPreferenceSet>;
  getMcpSetup(actor: Actor): Promise<McpSetupStatus>;
  setPreferredMcpClient(actor: Actor, client: GoatMcpClient): Promise<McpSetupStatus>;
};

const PREFERENCE_COLUMNS = {
  timezone: goatUsers.timezone,
  taskSpawningEnabled: goatUsers.taskSpawningEnabled,
  wikiEnabled: goatUsers.wikiEnabled,
  taskViewMode: goatUsers.taskViewMode,
  imessageEnabled: goatUsers.imessageEnabled,
  autoModelRoutingEnabled: goatUsers.autoModelRoutingEnabled,
};

export function createUserSettingsService(input: {
  db: DbLike;
  now?: () => Date;
}): UserSettingsService {
  const now = input.now ?? (() => new Date());

  return {
    async updatePreferences(actor, command) {
      const current = await currentPreferences(input.db, actor);
      const changes: Partial<UserPreferenceSet> = {};
      if (command.timezone !== undefined) {
        const timezone = normalizeScheduleTimezone(command.timezone);
        if (timezone !== current.timezone) changes.timezone = timezone;
      }
      for (const field of [
        "taskSpawningEnabled",
        "wikiEnabled",
        "imessageEnabled",
        "autoModelRoutingEnabled",
      ] as const) {
        const value = command[field];
        if (value !== undefined && value !== current[field]) changes[field] = value;
      }
      if (command.taskViewMode !== undefined && command.taskViewMode !== current.taskViewMode) {
        changes.taskViewMode = command.taskViewMode;
      }
      // No-op short-circuit: writing nothing keeps updatedAt stable when every
      // requested value already matches (e.g. the timezone sync on app load).
      if (Object.keys(changes).length === 0) return current;

      const [updated] = await input.db
        .update(goatUsers)
        .set({ ...changes, updatedAt: now() })
        .where(eq(goatUsers.workosUserId, actor.userId))
        .returning(PREFERENCE_COLUMNS);
      if (!updated) throw missingUser();
      return updated as UserPreferenceSet;
    },

    async getMcpSetup(actor) {
      const [row] = await input.db
        .select({
          preferredClient: goatUsers.preferredMcpClient,
          completedAt: goatUsers.mcpSetupCompletedAt,
        })
        .from(goatUsers)
        .where(eq(goatUsers.workosUserId, actor.userId))
        .limit(1);
      if (!row) throw missingUser();
      return mcpSetupStatus(row);
    },

    async setPreferredMcpClient(actor, client) {
      const [updated] = await input.db
        .update(goatUsers)
        .set({ preferredMcpClient: client, updatedAt: now() })
        .where(eq(goatUsers.workosUserId, actor.userId))
        .returning({
          preferredClient: goatUsers.preferredMcpClient,
          completedAt: goatUsers.mcpSetupCompletedAt,
        });
      if (!updated) throw missingUser();
      return mcpSetupStatus(updated);
    },
  };
}

async function currentPreferences(db: DbLike, actor: Actor): Promise<UserPreferenceSet> {
  const [row] = await db
    .select(PREFERENCE_COLUMNS)
    .from(goatUsers)
    .where(eq(goatUsers.workosUserId, actor.userId))
    .limit(1);
  if (!row) throw missingUser();
  return row as UserPreferenceSet;
}

function mcpSetupStatus(row: {
  preferredClient: GoatMcpClient | null;
  completedAt: Date | null;
}): McpSetupStatus {
  return {
    preferredClient: row.preferredClient,
    complete: Boolean(row.completedAt),
    completedAt: row.completedAt,
  };
}

function missingUser() {
  return new ApiError(404, "not_found", "The acting user's profile was not found.");
}
