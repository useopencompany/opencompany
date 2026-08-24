import type { PluginSkillCollision } from "@opencompany/core";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { pluginSkills, plugins, skillBundles, skillInstallations } from "./product-schema";

type DbClient = any;

export type ResolvedWorkspaceSkill = {
  id: string;
  bundleId: string;
  name: string;
  description: string;
  body: string;
  sourceKind: "standalone" | "plugin";
  installationId: string | null;
  pluginId: string | null;
  pluginName: string | null;
};

type StandaloneSkillCandidate = Omit<
  ResolvedWorkspaceSkill,
  "sourceKind" | "pluginId" | "pluginName"
>;

type PluginSkillCandidate = Omit<ResolvedWorkspaceSkill, "sourceKind" | "installationId"> & {
  pluginId: string;
  pluginName: string;
};

export type ResolvedWorkspaceSkillCatalog = {
  skills: ResolvedWorkspaceSkill[];
  collisions: PluginSkillCollision[];
};

/**
 * Resolves the portable Skill catalog once for every catalog, activation, collision-report, and
 * sandbox caller. Agent Skill and Plugin names are ASCII by specification, so relational string
 * comparison gives the required lexical order without depending on JavaScript locale or the
 * database cluster's collation.
 */
export async function resolveWorkspaceSkillCatalog(
  db: DbClient,
  input: { workspaceId: string; pluginIds?: readonly string[] },
): Promise<ResolvedWorkspaceSkillCatalog> {
  const standalonePromise = db
    .select({
      id: skillInstallations.name,
      bundleId: skillBundles.id,
      name: skillBundles.name,
      description: skillBundles.description,
      body: skillBundles.body,
      installationId: skillInstallations.id,
    })
    .from(skillInstallations)
    .innerJoin(
      skillBundles,
      and(
        eq(skillBundles.id, skillInstallations.bundleId),
        eq(skillBundles.workspaceId, skillInstallations.workspaceId),
      ),
    )
    .where(
      and(
        eq(skillInstallations.workspaceId, input.workspaceId),
        eq(skillBundles.workspaceId, input.workspaceId),
        eq(skillInstallations.enabled, true),
        isNull(skillInstallations.archivedAt),
      ),
    );

  const pluginIds = input.pluginIds ? [...new Set(input.pluginIds)] : undefined;
  const pluginPromise =
    pluginIds?.length === 0
      ? Promise.resolve([])
      : db
          .select({
            id: pluginSkills.skillName,
            bundleId: skillBundles.id,
            name: skillBundles.name,
            description: skillBundles.description,
            body: skillBundles.body,
            pluginId: plugins.id,
            pluginName: plugins.name,
          })
          .from(pluginSkills)
          .innerJoin(
            plugins,
            and(
              eq(plugins.id, pluginSkills.pluginId),
              eq(plugins.workspaceId, pluginSkills.workspaceId),
            ),
          )
          .innerJoin(
            skillBundles,
            and(
              eq(skillBundles.id, pluginSkills.skillBundleId),
              eq(skillBundles.workspaceId, pluginSkills.workspaceId),
            ),
          )
          .where(
            and(
              eq(pluginSkills.workspaceId, input.workspaceId),
              eq(plugins.workspaceId, input.workspaceId),
              eq(plugins.status, "enabled"),
              ...(pluginIds ? [inArray(plugins.id, pluginIds)] : []),
            ),
          );

  const [standaloneRows, pluginRows] = await Promise.all([standalonePromise, pluginPromise]);
  return resolveSkillCandidates(
    (standaloneRows as StandaloneSkillCandidate[]).map((row) => ({
      ...row,
      sourceKind: "standalone",
      pluginId: null,
      pluginName: null,
    })),
    (pluginRows as PluginSkillCandidate[]).map((row) => ({
      ...row,
      sourceKind: "plugin",
      installationId: null,
    })),
  );
}

export function resolveSkillCandidates(
  standaloneCandidates: readonly ResolvedWorkspaceSkill[],
  pluginCandidates: readonly ResolvedWorkspaceSkill[],
): ResolvedWorkspaceSkillCatalog {
  const winners = new Map<string, ResolvedWorkspaceSkill>();
  for (const candidate of [...standaloneCandidates].sort(compareCandidates)) {
    if (!winners.has(candidate.name)) winners.set(candidate.name, candidate);
  }

  const pluginsBySkill = new Map<string, ResolvedWorkspaceSkill[]>();
  for (const candidate of pluginCandidates) {
    const candidates = pluginsBySkill.get(candidate.name) ?? [];
    candidates.push(candidate);
    pluginsBySkill.set(candidate.name, candidates);
  }

  const collisions: PluginSkillCollision[] = [];
  for (const [skillName, candidates] of pluginsBySkill) {
    const sortedCandidates = [...candidates].sort(compareCandidates);
    const pluginNames = [
      ...new Set(
        sortedCandidates.map((candidate) => {
          if (!candidate.pluginName)
            throw new Error("Plugin Skill candidate is missing its Plugin name.");
          return candidate.pluginName;
        }),
      ),
    ];
    if (winners.has(skillName)) {
      collisions.push({
        skillName,
        winner: { source: "standalone" },
        hiddenPluginNames: pluginNames,
      });
      continue;
    }

    const winner = sortedCandidates[0];
    if (!winner) continue;
    winners.set(skillName, winner);
    if (pluginNames.length > 1) {
      collisions.push({
        skillName,
        winner: { source: "plugin", pluginName: winner.pluginName! },
        hiddenPluginNames: pluginNames.slice(1),
      });
    }
  }

  return {
    skills: [...winners.values()].sort((left, right) => compareText(left.name, right.name)),
    collisions: collisions.sort((left, right) => compareText(left.skillName, right.skillName)),
  };
}

function compareCandidates(left: ResolvedWorkspaceSkill, right: ResolvedWorkspaceSkill) {
  if (left.sourceKind !== right.sourceKind) return left.sourceKind === "standalone" ? -1 : 1;
  return (
    compareText(left.pluginName ?? "", right.pluginName ?? "") ||
    compareText(
      left.pluginId ?? left.installationId ?? "",
      right.pluginId ?? right.installationId ?? "",
    )
  );
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
