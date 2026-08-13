import { createHash } from "node:crypto";
import { type Actor, CoreError } from "@opencompany/core";
import { goatIntegrationCommandIdempotency } from "@opencompany/db/goat-schema";
import {
  type BrowserProfileView,
  browserProfilesAvailable,
  completeLoginSession,
  createBrowserProfile,
  createLoginSession,
  deleteBrowserProfile,
  listBrowserProfilesForUser,
  resolveLiveViewUrl,
} from "./index";

type DbLike = any;

// The shared browser-profile module throws user-facing plain Errors that runner tool results
// surface verbatim. The API boundary maps that bounded message set onto typed protocol codes
// without changing runner behavior.
const ERROR_CODES: ReadonlyArray<[RegExp, CoreError["code"]]> = [
  [/^Browser profiles are not enabled\.$/u, "unavailable"],
  [/^Browser profiles are temporarily disabled\.$/u, "unavailable"],
  [/^BROWSERBASE_API_KEY is required\.$/u, "unavailable"],
  [/^Browser profile not found\.$/u, "not_found"],
  [/already has an active session\.$/u, "conflict"],
  [/^This login session is no longer active\.$/u, "conflict"],
  [/^This browser session is not active\.$/u, "conflict"],
  [/^Profile name is required\.$/u, "invalid_argument"],
  [/^Site URL is required\.$/u, "invalid_argument"],
  [/^Site URL must use http or https\.$/u, "invalid_argument"],
  [/^Goat cannot connect browser profiles for this site\.$/u, "invalid_argument"],
];

export class GoatBrowserProfileApplicationService {
  constructor(private readonly db: DbLike) {}

  available(): boolean {
    return browserProfilesAvailable();
  }

  async list(actor: Actor): Promise<BrowserProfileView[]> {
    requireActor(actor);
    return listBrowserProfilesForUser(actor.userId, this.db);
  }

  async create(
    actor: Actor,
    input: { idempotencyKey: string; name: string; siteUrl: string },
  ): Promise<{ profile: BrowserProfileView; replayed: boolean }> {
    requireActor(actor);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    return mapped(async () => {
      const operation = "browser_profile.create" as const;
      const requestHash = createHash("sha256")
        .update(
          stableJson({
            operation,
            command: { name: input.name.trim(), siteUrl: input.siteUrl.trim() },
          }),
        )
        .digest("hex");
      const profileId = deterministicUuid(actor, idempotencyKey);
      const [reservation] = await this.db
        .insert(goatIntegrationCommandIdempotency)
        .values({
          commandId: deterministicCommandId(actor, idempotencyKey),
          userWorkosId: actor.userId,
          workspaceId: actor.workspaceId,
          idempotencyKey,
          requestHash,
          operation,
          resourceId: profileId,
        })
        .onConflictDoUpdate({
          target: [
            goatIntegrationCommandIdempotency.userWorkosId,
            goatIntegrationCommandIdempotency.workspaceId,
            goatIntegrationCommandIdempotency.idempotencyKey,
          ],
          set: { touchedAt: new Date() },
        })
        .returning({
          requestHash: goatIntegrationCommandIdempotency.requestHash,
          operation: goatIntegrationCommandIdempotency.operation,
          resourceId: goatIntegrationCommandIdempotency.resourceId,
        });
      if (!reservation) {
        throw new CoreError("conflict", "Could not reserve the browser-profile command.");
      }
      if (reservation.operation !== operation || reservation.requestHash !== requestHash) {
        throw new CoreError(
          "idempotency_conflict",
          "The Idempotency-Key was already used for another command.",
        );
      }

      const replay = await this.findOwnProfile(actor, reservation.resourceId);
      if (replay) return { profile: replay, replayed: true };

      try {
        const profile = await createBrowserProfile({
          userWorkosId: actor.userId,
          name: input.name,
          siteUrl: input.siteUrl,
          profileId: reservation.resourceId,
          db: this.db,
        });
        return { profile, replayed: false };
      } catch (error) {
        // A concurrent identical retry may have won the primary-key race; return its result.
        if (isUniqueViolation(error)) {
          const winner = await this.findOwnProfile(actor, reservation.resourceId);
          if (winner) return { profile: winner, replayed: true };
        }
        throw error;
      }
    });
  }

  async delete(actor: Actor, profileId: string): Promise<void> {
    requireActor(actor);
    await mapped(() =>
      deleteBrowserProfile({
        userWorkosId: actor.userId,
        profileId: resourceId(profileId),
        db: this.db,
      }),
    );
  }

  async startLoginSession(
    actor: Actor,
    profileId: string,
  ): Promise<{ sessionId: string; liveViewUrl: string }> {
    requireActor(actor);
    return mapped(() =>
      createLoginSession({
        userWorkosId: actor.userId,
        profileId: resourceId(profileId),
        db: this.db,
      }),
    );
  }

  async completeLoginSession(actor: Actor, profileId: string, sessionId: string): Promise<void> {
    requireActor(actor);
    await mapped(() =>
      completeLoginSession({
        userWorkosId: actor.userId,
        profileId: resourceId(profileId),
        sessionId: resourceId(sessionId),
        db: this.db,
      }),
    );
  }

  async liveViewUrl(actor: Actor, profileId: string, sessionId: string): Promise<string> {
    requireActor(actor);
    return mapped(() =>
      resolveLiveViewUrl({
        userWorkosId: actor.userId,
        profileId: resourceId(profileId),
        sessionId: resourceId(sessionId),
        db: this.db,
      }),
    );
  }

  private async findOwnProfile(actor: Actor, profileId: string) {
    const profiles = await listBrowserProfilesForUser(actor.userId, this.db);
    return profiles.find((profile) => profile.id === profileId) ?? null;
  }
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CoreError) throw error;
    const message = error instanceof Error ? error.message : "";
    for (const [pattern, code] of ERROR_CODES) {
      if (pattern.test(message)) throw new CoreError(code, message);
    }
    throw error;
  }
}

function requireActor(actor: Actor) {
  if (!actor.userId.trim() || !actor.workspaceId.trim()) {
    throw new CoreError("forbidden", "The actor is not allowed to manage browser profiles.");
  }
}

function resourceId(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[^\w:.-]/u.test(normalized)) {
    throw new CoreError("invalid_argument", "The resource identifier is invalid.");
  }
  return normalized;
}

function normalizeIdempotencyKey(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[^\x21-\x7e]/u.test(normalized)) {
    throw new CoreError("invalid_argument", "A valid Idempotency-Key is required.");
  }
  return normalized;
}

function deterministicCommandId(actor: Actor, key: string) {
  const digest = createHash("sha256")
    .update(["goat_integration_command", actor.userId, actor.workspaceId, key].join("\n"))
    .digest("hex")
    .slice(0, 32);
  return `goat_integration_command_${digest}`;
}

// Browser profile IDs are plain UUIDs today; the deterministic replay ID keeps that shape.
function deterministicUuid(actor: Actor, key: string) {
  const digest = createHash("sha256")
    .update(["goat_browser_profile", actor.userId, actor.workspaceId, key].join("\n"))
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isUniqueViolation(error: unknown) {
  for (
    let current = error;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause ?? null
  ) {
    if ((current as { code?: string }).code === "23505") return true;
  }
  return false;
}
