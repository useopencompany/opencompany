import { getDb } from "@opencompany/db/client";
import { goatBrainDocuments, goatBrainSources, goatBrainToolRuns } from "@opencompany/db/schema";
import { and, count, eq, gte, inArray, ne } from "drizzle-orm";
import { GOAT_BRAIN_READ_PLANE_COMMANDS } from "@/lib/brain-surface";

export type GoatBrainOverviewStats = {
  windowStartedAt: string;
  itemsAddedLast7Days: number;
  retrievalsLast7Days: number;
  activeSources: number;
};

// Retrievals are the read-plane commands: keep this tied to the shared surface
// constant so a new read verb is counted without editing this file too.
const BRAIN_RETRIEVAL_ACTIONS = GOAT_BRAIN_READ_PLANE_COMMANDS;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

export async function getGoatBrainOverviewStats(
  brainRef: string,
  now = new Date(),
  db = getDb(),
): Promise<GoatBrainOverviewStats> {
  const cutoff = new Date(now.getTime() - SEVEN_DAYS_MS);
  const [[itemsAdded], [retrievals], [sources]] = await Promise.all([
    db
      .select({ value: count() })
      .from(goatBrainDocuments)
      .where(
        and(eq(goatBrainDocuments.brainRef, brainRef), gte(goatBrainDocuments.createdAt, cutoff)),
      ),
    db
      .select({ value: count() })
      .from(goatBrainToolRuns)
      .where(
        and(
          eq(goatBrainToolRuns.brainRef, brainRef),
          eq(goatBrainToolRuns.ok, true),
          gte(goatBrainToolRuns.createdAt, cutoff),
          inArray(goatBrainToolRuns.action, BRAIN_RETRIEVAL_ACTIONS),
        ),
      ),
    db
      .select({ value: count() })
      .from(goatBrainSources)
      .where(
        and(
          eq(goatBrainSources.brainId, brainRef),
          eq(goatBrainSources.enabled, true),
          ne(goatBrainSources.provider, "slack_bot"),
        ),
      ),
  ]);

  return {
    windowStartedAt: cutoff.toISOString(),
    itemsAddedLast7Days: itemsAdded?.value ?? 0,
    retrievalsLast7Days: retrievals?.value ?? 0,
    activeSources: sources?.value ?? 0,
  };
}
