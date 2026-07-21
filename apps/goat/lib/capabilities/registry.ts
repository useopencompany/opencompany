import { attioCapability } from "@/lib/capabilities/attio";
import { linearCapability } from "@/lib/capabilities/linear";
import { slackCapability } from "@/lib/capabilities/slack";
import type {
  GoatCapabilityDefinition,
  GoatCapabilityId,
  ResolvedGoatCapability,
} from "@/lib/capabilities/types";
import { youtubeTranscriptCapability } from "@/lib/capabilities/youtube-transcript";

const GOAT_CAPABILITY_REGISTRY: readonly GoatCapabilityDefinition[] = [
  slackCapability,
  linearCapability,
  youtubeTranscriptCapability,
  attioCapability,
];

const MUTATING_CAPABILITY_IDS = new Set<GoatCapabilityId>(["linear", "attio"]);

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
      // Mutating workers require an explicit registry decision. This prevents
      // widening a read integration merely by changing its resolver output.
      if (
        availability.operations.some((operation) => operation !== "read") &&
        !MUTATING_CAPABILITY_IDS.has(definition.id)
      ) {
        throw new Error(`Capability ${definition.id} is not approved for foreground mutations.`);
      }
      return {
        id: definition.id,
        workerModel: definition.workerModel,
        ...availability,
      } satisfies ResolvedGoatCapability;
    }),
  );
  return resolved.filter((entry): entry is ResolvedGoatCapability => entry !== null);
}
