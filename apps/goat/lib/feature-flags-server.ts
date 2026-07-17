import { getDb } from "@opencompany/db/client";
import { goatUsers } from "@opencompany/db/goat-schema";
import { eq } from "drizzle-orm";
import { goatFeatureFlagsFromUser } from "@/lib/feature-flags";

export async function loadGoatFeatureFlagsForUser(userWorkosId: string) {
  const [user] = await getDb()
    .select({
      localCodexBetaEnabled: goatUsers.localCodexBetaEnabled,
      mainChatIntegrationToolsBetaEnabled: goatUsers.mainChatIntegrationToolsBetaEnabled,
    })
    .from(goatUsers)
    .where(eq(goatUsers.workosUserId, userWorkosId))
    .limit(1);

  return goatFeatureFlagsFromUser(user ?? {});
}

export async function isLocalCodexBridgeBetaEnabledForUser(userWorkosId: string) {
  const flags = await loadGoatFeatureFlagsForUser(userWorkosId);
  return flags.localCodexBridge;
}
