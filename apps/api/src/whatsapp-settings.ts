import type { Actor } from "@opencompany/core";
import { users, type WhatsappBinding } from "@opencompany/db/product-schema";
import {
  deleteWhatsappBinding,
  getWhatsappBinding,
  startWhatsappLink,
} from "@opencompany/db/whatsapp";
import type { WhatsappSettingsDto } from "@opencompany/protocol";
import { eq } from "drizzle-orm";
import { ApiError } from "./errors";

type DbLike = any;

export type WhatsappSettingsService = {
  get(actor: Actor): Promise<WhatsappSettingsDto>;
  startLink(actor: Actor): Promise<WhatsappSettingsDto>;
  unlink(actor: Actor): Promise<WhatsappSettingsDto>;
};

// Settings → Channels → WhatsApp. Everything here is gated by the member's own beta flag, the
// same way Bots are: with the flag off the channel does not exist for that user.
export function createWhatsappSettingsService(input: {
  db: DbLike;
  lineHandle: () => string | null;
}): WhatsappSettingsService {
  async function authorize(actor: Actor) {
    const [row] = await input.db
      .select({ enabled: users.whatsappEnabled })
      .from(users)
      .where(eq(users.workosUserId, actor.userId))
      .limit(1);
    if (!row?.enabled) throw new ApiError(404, "not_found", "WhatsApp is not enabled.");
  }
  const dto = (binding: WhatsappBinding | null): WhatsappSettingsDto => {
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
      return dto(await getWhatsappBinding({ userWorkosId: actor.userId }, input.db));
    },
    async startLink(actor) {
      await authorize(actor);
      if (input.lineHandle() === null) {
        throw new ApiError(503, "unavailable", "WhatsApp is not configured on this deployment.");
      }
      return dto(
        await startWhatsappLink(
          { userWorkosId: actor.userId, workspaceId: actor.workspaceId },
          input.db,
        ),
      );
    },
    async unlink(actor) {
      await authorize(actor);
      await deleteWhatsappBinding({ userWorkosId: actor.userId }, input.db);
      return dto(null);
    },
  };
}
