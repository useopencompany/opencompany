import { OFFICIAL_PLUGIN_LABELS } from "@opencompany/agent-runtime/official-plugin-catalog";
import { AD_HOC_TASK_ID } from "@opencompany/core/ad-hoc-task";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useAuth } from "@/features/auth";
import type { AuthenticatedApi, WorkflowCatalogItem } from "@/shared/api/opencompany-api";
import { analytics } from "@/shared/lib/analytics";
import { queryClient } from "@/shared/lib/query-client";
import type {
  QuickActionTrigger,
  QuickActionTriggerCharacter,
} from "../../native/native-composer-input";
import { chatQueryKeys } from "../chat-queries";
import type { ChatPartition } from "../chat-store";
import { type ComposerMention, type ComposerTokenSegment, createToken } from "./composer-segments";
import { filterQuickActions } from "./quick-action-filter";

export interface QuickActionItem {
  key: string;
  label: string;
  /** The short tag on the row's right edge. */
  tag: string;
  token: ComposerTokenSegment;
  /** A disabled Plugin can still be mentioned, but reads as off. */
  dimmed: boolean;
  /** Ids and slugs a query may also start with. */
  aliases: string[];
}

type Catalog = "references" | "skills" | "workflows";

const CATALOG_BY_TRIGGER: Record<QuickActionTriggerCharacter, Catalog> = {
  "@": "references",
  "/": "skills",
  "#": "workflows",
};

const HEADERS: Record<QuickActionTriggerCharacter, string> = {
  "@": "Type to search integrations",
  "/": "Type to search skills",
  "#": "Type to search Tasks and workflows",
};

const LOAD_ERRORS: Record<Catalog, string> = {
  references: "Couldn't load integrations. Tap to retry",
  skills: "Couldn't load skills. Tap to retry",
  workflows: "Couldn't load workflows. Tap to retry",
};

const STALE_TIME = 5 * 60_000;
const MAX_ROWS = 50;

const AD_HOC_TASK_ITEM: QuickActionItem = {
  key: "task",
  label: "Ad-hoc Task",
  tag: "Task",
  token: createToken("task", AD_HOC_TASK_ID, "Task"),
  dimmed: false,
  aliases: [AD_HOC_TASK_ID],
};

const pluginLabel = (name: string): string => {
  // The mention reads as the service. "GitHub as you" names the plugin's settings page.
  if (name === "github") return "GitHub";
  return OFFICIAL_PLUGIN_LABELS[name as keyof typeof OFFICIAL_PLUGIN_LABELS] ?? name;
};

// Plugins and repositories load independently. One failing still shows what the other found;
// only both failing is an error.
const loadReferences = async (
  api: AuthenticatedApi,
  signal: AbortSignal,
): Promise<QuickActionItem[]> => {
  const [plugins, repositories] = await Promise.allSettled([
    api.listPlugins(signal),
    api.listGitHubRepositories(signal),
  ]);
  if (plugins.status === "rejected")
    analytics.capture("quick_action_catalog_failed", { catalog: "plugins" });
  if (repositories.status === "rejected")
    analytics.capture("quick_action_catalog_failed", { catalog: "repositories" });
  if (plugins.status === "rejected" && repositories.status === "rejected") throw plugins.reason;

  const live =
    plugins.status === "fulfilled"
      ? plugins.value.filter((plugin) => plugin.status !== "archived")
      : [];
  const items: QuickActionItem[] = [
    ...live.filter((plugin) => plugin.status === "enabled"),
    ...live.filter((plugin) => plugin.status === "disabled"),
  ].map((plugin) => ({
    key: `plugin:${plugin.name}`,
    label: pluginLabel(plugin.name),
    tag: plugin.status === "disabled" ? "Disabled" : "Plugin",
    token: createToken("plugin", plugin.name, pluginLabel(plugin.name)),
    dimmed: plugin.status === "disabled",
    aliases: [plugin.name],
  }));
  if (repositories.status === "fulfilled") {
    const seen = new Set<string>();
    for (const installation of repositories.value.installations) {
      if (installation.suspendedAt) continue;
      for (const repository of installation.repositories) {
        if (seen.has(repository.id)) continue;
        seen.add(repository.id);
        items.push({
          key: `repository:${repository.id}`,
          label: repository.fullName,
          tag: "Repo",
          token: createToken("repository", repository.fullName, repository.fullName),
          dimmed: false,
          aliases: [],
        });
      }
    }
  }
  return items;
};

const loadSkills = async (api: AuthenticatedApi, signal: AbortSignal) =>
  (await api.listSkillCatalog(signal)).map(
    (skill): QuickActionItem => ({
      key: `skill:${skill.id}`,
      label: skill.name,
      tag:
        skill.scope === "personal" ? "Personal" : skill.scope === "company" ? "Company" : "Plugin",
      token: createToken("skill", skill.id, skill.name),
      dimmed: false,
      aliases: [skill.id],
    }),
  );

// Matches web `workflowDtoToCatalogItem`: only active workflows whose steps all have
// instructions can run.
const isInvocable = (workflow: WorkflowCatalogItem) =>
  workflow.status === "active" &&
  workflow.steps.length > 0 &&
  workflow.steps.every((step) => step.instructions.trim());

const loadWorkflows = async (api: AuthenticatedApi, signal: AbortSignal) =>
  (await api.listWorkflows(signal)).filter(isInvocable).map(
    (workflow): QuickActionItem => ({
      key: `workflow:${workflow.slug}`,
      label: workflow.name,
      tag: "Workflow",
      token: createToken("workflow", workflow.slug, workflow.name),
      dimmed: false,
      aliases: [workflow.slug],
    }),
  );

const LOADERS: Record<
  Catalog,
  (api: AuthenticatedApi, signal: AbortSignal) => Promise<QuickActionItem[]>
> = {
  references: loadReferences,
  skills: loadSkills,
  workflows: loadWorkflows,
};

const catalogQueryOptions = (
  api: AuthenticatedApi,
  partition: ChatPartition | null,
  catalog: Catalog,
) =>
  queryOptions({
    queryKey: partition
      ? chatQueryKeys.quickActions(partition, catalog)
      : ["chat", "quick-actions", "signed-out", catalog],
    queryFn: async ({ signal }) => {
      try {
        return await LOADERS[catalog](api, signal);
      } catch (error) {
        if (!signal.aborted) analytics.capture("quick_action_catalog_failed", { catalog });
        throw error;
      }
    },
    enabled: Boolean(partition),
    staleTime: STALE_TIME,
  });

/** Loads every menu ahead of the first keystroke. Fresh catalogs are left alone. */
export const prefetchQuickActions = (api: AuthenticatedApi, partition: ChatPartition): void => {
  for (const catalog of ["references", "skills", "workflows"] as const)
    void queryClient.prefetchQuery(catalogQueryOptions(api, partition, catalog));
};

/**
 * The rows for the active trigger, read from the prefetched cache. A stale catalog refreshes in
 * the background; the menu never waits on it.
 */
export function useQuickActionMenu({
  partition,
  trigger,
  mentions,
}: {
  partition: ChatPartition | null;
  trigger: QuickActionTrigger | null;
  mentions: readonly ComposerMention[];
}): {
  items: QuickActionItem[];
  header: string | null;
  error: string | null;
  retry: () => void;
} {
  const { api } = useAuth();
  const catalog = CATALOG_BY_TRIGGER[trigger?.trigger ?? "@"];
  const query = useQuery({
    ...catalogQueryOptions(api, partition, catalog),
    enabled: Boolean(partition && trigger),
  });
  const retry = () => void query.refetch();
  if (!trigger) return { items: [], header: null, error: null, retry };

  let available = query.data ?? [];
  if (trigger.trigger === "/") {
    available = available.filter(
      (item) =>
        !mentions.some((mention) => mention.kind === "skill" && mention.id === item.token.id),
    );
  } else if (trigger.trigger === "#") {
    // One Task per message: a draft that already starts one offers nothing more.
    available = mentions.some((mention) => mention.kind !== "skill")
      ? []
      : [AD_HOC_TASK_ITEM, ...available];
  }
  return {
    items: filterQuickActions(available, trigger.query).slice(0, MAX_ROWS),
    header: trigger.query ? null : HEADERS[trigger.trigger],
    error: query.isError && !query.data ? LOAD_ERRORS[catalog] : null,
    retry,
  };
}
