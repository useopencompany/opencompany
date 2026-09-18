import type { Actor } from "@opencompany/core";
import {
  deleteImessageBinding,
  getImessageBinding,
  startImessageLink,
} from "@opencompany/db/imessage";
import { type ImessageBinding, users } from "@opencompany/db/product-schema";
import type { ImessageSettingsDto } from "@opencompany/protocol";
import { eq } from "drizzle-orm";
import { ApiError } from "./errors";

type DbLike = any;

export type ImessageSettingsService = {
  get(actor: Actor): Promise<ImessageSettingsDto>;
  startLink(actor: Actor): Promise<ImessageSettingsDto>;
  unlink(actor: Actor): Promise<ImessageSettingsDto>;
};

// Settings → Channels → iMessage. Everything here is gated by the member's own beta flag, the
// same way Bots are: with the flag off the channel does not exist for that user.
export function createImessageSettingsService(input: {
  db: DbLike;
  lineHandle: () => string | null;
}): ImessageSettingsService {
  async function authorize(actor: Actor) {
    const [row] = await input.db
      .select({ enabled: users.imessageEnabled })
      .from(users)
      .where(eq(users.workosUserId, actor.userId))
      .limit(1);
    if (!row?.enabled) throw new ApiError(404, "not_found", "iMessage is not enabled.");
  }
  const dto = (binding: ImessageBinding | null): ImessageSettingsDto => {
    const lineHandle = input.lineHandle();
    return {
      configured: lineHandle !== null,
      lineHandle,
      binding: binding
        ? {
            status: binding.status,
            linkCode: binding.linkCode,
            linkCodeExpiresAt: binding.linkCodeExpiresAt?.toISOString() ?? null,
            handle: binding.handle,
            conversationId: binding.conversationId,
            linkedAt: binding.linkedAt?.toISOString() ?? null,
          }
        : null,
    };
  };
  return {
    async get(actor) {
      await authorize(actor);
      return dto(await getImessageBinding({ userWorkosId: actor.userId }, input.db));
    },
    async startLink(actor) {
      await authorize(actor);
      if (input.lineHandle() === null) {
        throw new ApiError(503, "unavailable", "iMessage is not configured on this deployment.");
      }
      return dto(
        await startImessageLink(
          { userWorkosId: actor.userId, workspaceId: actor.workspaceId },
          input.db,
        ),
      );
    },
    async unlink(actor) {
      await authorize(actor);
      await deleteImessageBinding({ userWorkosId: actor.userId }, input.db);
      return dto(null);
    },
  };
}
