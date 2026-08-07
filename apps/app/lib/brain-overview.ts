import { BRAIN_READ_PLANE_COMMANDS } from "@opencompany/core/brain-surface";
import { getDb } from "@opencompany/db/client";
import { brainDocuments, brainSources, brainToolRuns } from "@opencompany/db/schema";
import { and, count, eq, gte, inArray, ne } from "drizzle-orm";

export type BrainOverviewStats = {
  windowStartedAt: string;
  itemsAddedLast7Days: number;
  retrievalsLast7Days: number;
  activeSources: number;
};

// Retrievals are the read-plane commands: keep this tied to the shared surface
// constant so a new read verb is counted without editing this file too.
const BRAIN_RETRIEVAL_ACTIONS = BRAIN_READ_PLANE_COMMANDS;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

export async function getBrainOverviewStats(
  brainRef: string,
  now = new Date(),
  db = getDb(),
): Promise<BrainOverviewStats> {
  const cutoff = new Date(now.getTime() - SEVEN_DAYS_MS);
  const [[itemsAdded], [retrievals], [sources]] = await Promise.all([
    db
      .select({ value: count() })
      .from(brainDocuments)
      .where(and(eq(brainDocuments.brainRef, brainRef), gte(brainDocuments.createdAt, cutoff))),
    db
      .select({ value: count() })
      .from(brainToolRuns)
      .where(
        and(
          eq(brainToolRuns.brainRef, brainRef),
          eq(brainToolRuns.ok, true),
          gte(brainToolRuns.createdAt, cutoff),
          inArray(brainToolRuns.action, BRAIN_RETRIEVAL_ACTIONS),
        ),
      ),
    db
      .select({ value: count() })
      .from(brainSources)
      .where(
        and(
          eq(brainSources.brainId, brainRef),
          eq(brainSources.enabled, true),
          ne(brainSources.provider, "slack_bot"),
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
