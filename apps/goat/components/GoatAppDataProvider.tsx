"use client";

import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { normalizeGoatBrainBody } from "@opencompany/goat-brain/document";
import { useLiveQuery } from "@tanstack/react-db";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { GoatTaskView } from "@/components/GoatSurface";
import type { GoatBrainDocumentView, GoatBrainFolderView, GoatBrainSnapshot } from "@/lib/brain";
import type { GoatChatSummaryView } from "@/lib/chat-ui";
import { type GoatIntegrationState, goatIntegrationStateFromRows } from "@/lib/integration-state";
import {
  createGoatCollections,
  type GoatBrainDocumentRow,
  type GoatBrainEdgeRow,
  type GoatBrainTimelineEntryRow,
  type GoatChatSessionRow,
  type GoatIntegrationRow,
  type GoatTaskRow,
  type GoatTaskScheduleRow,
} from "@/lib/task-collections";
import type { GoatTaskScheduleView } from "@/lib/task-schedules";

type GoatUserView = {
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};

export type GoatWorkspaceView = {
  id: string;
  name: string;
  role: "admin" | "member";
};

export type GoatBrainSummaryView = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: "workspace" | "restricted";
};

export type GoatAppInitialData = {
  user: GoatUserView;
  workspace: GoatWorkspaceView;
  brains: GoatBrainSummaryView[];
  activeBrain: GoatBrainSummaryView | null;
  tasks: GoatTaskView[];
  schedules: GoatTaskScheduleView[];
  recentChats: GoatChatSummaryView[];
  integrations: GoatIntegrationState;
  brain: GoatBrainSnapshot;
  codexConnected: boolean;
};

type GoatAppData = GoatAppInitialData & {
  brainEdges: GoatBrainEdgeRow[];
  taskRows: GoatTaskRow[];
};

const GoatAppDataContext = createContext<GoatAppData | null>(null);

export function GoatAppDataProvider({
  initialData,
  children,
}: {
  initialData: GoatAppInitialData;
  children: ReactNode;
}) {
  const collections = useMemo(() => createGoatCollections(), []);
  // Switching the active brain swaps the brain shape subscriptions in place.
  const brainCollections = useMemo(
    () => collections.brainCollections(initialData.activeBrain?.id ?? "__no-brain__"),
    [collections, initialData.activeBrain?.id],
  );
  const { data: taskRows, isLoading: tasksLoading } = useLiveQuery((q) =>
    q.from({ task: collections.tasks }),
  );
  const { data: scheduleRows, isLoading: schedulesLoading } = useLiveQuery((q) =>
    q.from({ schedule: collections.taskSchedules }),
  );
  const { data: chatSessionRows, isLoading: chatsLoading } = useLiveQuery((q) =>
    q.from({ session: collections.chatSessions }),
  );
  const { data: integrationRows, isLoading: integrationsLoading } = useLiveQuery((q) =>
    q.from({ integration: collections.integrations }),
  );
  const { data: brainRows, isLoading: brainLoading } = useLiveQuery(
    (q) => q.from({ file: brainCollections.documents }),
    [brainCollections],
  );
  const { data: timelineRows } = useLiveQuery(
    (q) => q.from({ timeline: brainCollections.timelineEntries }),
    [brainCollections],
  );
  const { data: edgeRows } = useLiveQuery(
    (q) => q.from({ edge: brainCollections.edges }),
    [brainCollections],
  );

  const tasks = useMemo(() => {
    if (tasksLoading && !taskRows?.length) return initialData.tasks;
    return ((taskRows ?? []) as GoatTaskRow[])
      .map(taskRowToView)
      .filter((task) => !task.archivedAt)
      .toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [initialData.tasks, taskRows, tasksLoading]);

  const schedules = useMemo(() => {
    if (schedulesLoading && !scheduleRows?.length) return initialData.schedules;
    return ((scheduleRows ?? []) as GoatTaskScheduleRow[])
      .filter((row) => !row.deleted_at)
      .map(taskScheduleRowToView)
      .toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [initialData.schedules, scheduleRows, schedulesLoading]);

  const recentChats = useMemo(() => {
    if (chatsLoading && !chatSessionRows?.length) return initialData.recentChats;
    const initialById = new Map(initialData.recentChats.map((chat) => [chat.id, chat]));
    return ((chatSessionRows ?? []) as GoatChatSessionRow[])
      .filter((row) => !row.closed_at)
      .toSorted((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 8)
      .map((row) => {
        const initial = initialById.get(row.id);
        return {
          id: row.id,
          title: row.title,
          model: row.model as AgentModelId,
          preview: initial?.preview ?? "No messages yet.",
          updatedAt: row.updated_at,
        };
      });
  }, [chatSessionRows, chatsLoading, initialData.recentChats]);

  const integrations = useMemo(() => {
    if (integrationsLoading && !integrationRows?.length) return initialData.integrations;
    return {
      ...goatIntegrationStateFromRows((integrationRows ?? []) as GoatIntegrationRow[]),
      codex: initialData.integrations.codex,
      jamie: {
        ...goatIntegrationStateFromRows((integrationRows ?? []) as GoatIntegrationRow[]).jamie,
        integrationId: initialData.integrations.jamie.integrationId,
        webhookUrl: initialData.integrations.jamie.webhookUrl,
      },
    };
  }, [initialData.integrations, integrationRows, integrationsLoading]);

  const brain = useMemo(() => {
    if (brainLoading && !brainRows?.length) return initialData.brain;
    const timelinesByDocument = groupTimelineRows(
      (timelineRows ?? []) as GoatBrainTimelineEntryRow[],
    );
    const documents = ((brainRows ?? []) as GoatBrainDocumentRow[])
      .map((row) => documentViewFromRow(row, timelinesByDocument.get(row.id)))
      .toSorted(compareBrainDocuments);
    return {
      documents,
      folders: deriveFolderViews(documents),
    };
  }, [brainLoading, brainRows, initialData.brain, timelineRows]);

  const value = useMemo<GoatAppData>(
    () => ({
      ...initialData,
      tasks,
      schedules,
      recentChats,
      integrations,
      brain,
      brainEdges: (edgeRows ?? []) as GoatBrainEdgeRow[],
      taskRows: (taskRows ?? []) as GoatTaskRow[],
    }),
    [brain, edgeRows, initialData, integrations, recentChats, schedules, taskRows, tasks],
  );

  return <GoatAppDataContext.Provider value={value}>{children}</GoatAppDataContext.Provider>;
}

export function useGoatAppData() {
  const value = useContext(GoatAppDataContext);
  if (!value) throw new Error("useGoatAppData must be used within GoatAppDataProvider.");
  return value;
}

function taskRowToView(row: GoatTaskRow): GoatTaskView {
  return {
    id: row.id,
    displayId: row.display_id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for,
    status: row.status,
    stage: row.stage,
    result: row.result,
    error: row.error,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskScheduleRowToView(row: GoatTaskScheduleRow): GoatTaskScheduleView {
  return {
    id: row.id,
    name: row.name,
    sourceDescription: row.source_description,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    enabled: row.enabled,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function documentViewFromRow(
  row: GoatBrainDocumentRow,
  timelineRows?: GoatBrainTimelineEntryRow[],
): GoatBrainDocumentView {
  const path = `${row.folder_path}/${row.brain_id}.md`;
  return {
    id: row.id,
    brainId: row.brain_id,
    folderPath: row.folder_path,
    path,
    title: row.title ?? row.brain_id,
    content: row.content,
    body: normalizeGoatBrainBody(row.body),
    timeline: timelineRows ? timelineRowsFromRows(timelineRows) : normalizeTimeline(row.timeline),
    format: normalizeFormat(row.format),
    mimeType: row.mime_type ?? "text/markdown",
    originalFileName: row.original_file_name,
    assetStorageKey: row.asset_storage_key,
    relations: normalizeRelations(row.relations),
    sources: normalizeSources(row.sources),
    kind: normalizeDocumentKind(row.kind),
    type: normalizeEntityType(row.entity_type),
    status: normalizeStatus(row.status),
    aliases: normalizeStringArray(row.aliases),
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    parseError: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function groupTimelineRows(rows: GoatBrainTimelineEntryRow[]) {
  const byDocument = new Map<string, GoatBrainTimelineEntryRow[]>();
  for (const row of rows) {
    const current = byDocument.get(row.document_id) ?? [];
    current.push(row);
    byDocument.set(row.document_id, current);
  }
  for (const [documentId, values] of byDocument) {
    byDocument.set(
      documentId,
      values.toSorted((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()),
    );
  }
  return byDocument;
}

function timelineRowsFromRows(
  rows: GoatBrainTimelineEntryRow[],
): GoatBrainDocumentView["timeline"] {
  return rows.map((row) => ({
    evidenceId: row.evidence_id,
    at: row.at,
    body: [row.summary, row.detail, sourceLine(row)].filter(Boolean).join("\n\n"),
  }));
}

function sourceLine(row: GoatBrainTimelineEntryRow) {
  if (!row.source_ref) return "";
  return `Source: ${row.source_title ? `${row.source_title} (${row.source_ref})` : row.source_ref}`;
}

function compareBrainDocuments(a: GoatBrainDocumentView, b: GoatBrainDocumentView) {
  const folder = a.folderPath.localeCompare(b.folderPath);
  if (folder !== 0) return folder;
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function deriveFolderViews(documents: GoatBrainDocumentView[]): GoatBrainFolderView[] {
  const byPath = new Map<string, GoatBrainFolderView>();
  const zero = new Date(0).toISOString();
  for (const folder of DEFAULT_BRAIN_FOLDERS) {
    byPath.set(folder, {
      id: `folder:${folder}`,
      path: folder,
      name: folderName(folder),
      source: "system",
      createdAt: zero,
      updatedAt: zero,
    });
  }
  for (const document of documents) {
    for (const path of ancestorFolderPaths(document.folderPath)) {
      const existing = byPath.get(path);
      byPath.set(path, {
        id: `folder:${path}`,
        path,
        name: folderName(path),
        source: DEFAULT_BRAIN_FOLDERS.includes(path) ? "system" : "custom",
        createdAt: existing?.createdAt ?? document.createdAt,
        updatedAt:
          existing && existing.updatedAt > document.updatedAt
            ? existing.updatedAt
            : document.updatedAt,
      });
    }
  }
  return [...byPath.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

const DEFAULT_BRAIN_FOLDERS = [
  "inbox",
  "people",
  "companies",
  "projects",
  "meetings",
  "concepts",
  "analysis",
  "sources",
  "evidence",
];

function ancestorFolderPaths(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function folderName(folderPath: string) {
  const name = folderPath.split("/").filter(Boolean).at(-1) ?? folderPath;
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function normalizeTimeline(
  value: GoatBrainDocumentRow["timeline"],
): GoatBrainDocumentView["timeline"] {
  return Array.isArray(value)
    ? value.flatMap((entry): GoatBrainDocumentView["timeline"] => {
        const evidenceId = entry.evidenceId ?? entry.evidence_id;
        return entry.at && entry.body
          ? [{ evidenceId: evidenceId ?? "", at: entry.at, body: entry.body }]
          : [];
      })
    : [];
}

function normalizeFormat(value: string): GoatBrainDocumentView["format"] {
  if (value === "pdf" || value === "docx") return value;
  return "markdown";
}

function normalizeDocumentKind(value: string): GoatBrainDocumentView["kind"] {
  return value === "evidence" ? "evidence" : "page";
}

function normalizeEntityType(value: string): GoatBrainDocumentView["type"] {
  if (
    value === "person" ||
    value === "company" ||
    value === "project" ||
    value === "meeting" ||
    value === "concept" ||
    value === "source" ||
    value === "analysis" ||
    value === "note"
  ) {
    return value;
  }
  return "note";
}

function normalizeStatus(value: string): GoatBrainDocumentView["status"] {
  if (value === "active" || value === "archived" || value === "merged") return value;
  return "draft";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeRelations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): GoatBrainDocumentView["relations"] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.to !== "string") return [];
    return [{ type: typeof record.type === "string" ? record.type : "related", to: record.to }];
  });
}

function normalizeSources(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): GoatBrainDocumentView["sources"] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.ref !== "string") return [];
    return [
      {
        ref: record.ref,
        ...(typeof record.title === "string" ? { title: record.title } : {}),
        ...(typeof record.capturedAt === "string" ? { capturedAt: record.capturedAt } : {}),
      },
    ];
  });
}
