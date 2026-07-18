import { linearCapability } from "@/lib/capabilities/linear";
import { slackCapability } from "@/lib/capabilities/slack";
import type { GoatCapabilityDefinition, ResolvedGoatCapability } from "@/lib/capabilities/types";
import { youtubeTranscriptCapability } from "@/lib/capabilities/youtube-transcript";

const GOAT_CAPABILITY_REGISTRY: readonly GoatCapabilityDefinition[] = [
  slackCapability,
  linearCapability,
  youtubeTranscriptCapability,
];

for (const definition of GOAT_CAPABILITY_REGISTRY) {
  // v1 is read-only end to end; a non-read capability slipping in here would
  // silently widen what a worker model can do with user credentials.
  if (definition.sideEffect !== "read") {
    throw new Error(`Capability ${definition.id} is not read-class; v1 registers read tools only.`);
  }
}

// Global kill switch: disables capabilities for everyone regardless of the
// per-user beta flag, without a deploy rollback.
export function isGoatChatCapabilitiesKilled() {
  return process.env.GOAT_CHAT_CAPABILITIES_KILL_SWITCH === "true";
}

export async function resolveGoatCapabilityUniverse(
  userWorkosId: string,
): Promise<ResolvedGoatCapability[]> {
  const resolved = await Promise.all(
    GOAT_CAPABILITY_REGISTRY.map(async (definition) => {
      const availability = await definition.resolve(userWorkosId).catch(() => null);
      if (!availability) return null;
      return {
        id: definition.id,
        workerModel: definition.workerModel,
        ...availability,
      } satisfies ResolvedGoatCapability;
    }),
  );
  return resolved.filter((entry): entry is ResolvedGoatCapability => entry !== null);
}
