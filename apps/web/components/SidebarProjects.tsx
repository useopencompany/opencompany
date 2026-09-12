"use client";

import type { ProjectDto } from "@opencompany/protocol";
import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import { toast } from "@opencompany/ui/components/sonner";
import {
  ChevronDown,
  Folder,
  MoreHorizontal,
  PenLine,
  Plus,
  SquarePen,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import {
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  SIDEBAR_SECTION_ACTION_CLASSNAME,
  SidebarSectionHeader,
  useCollapsedSidebarSection,
} from "@/components/SidebarSection";
import {
  createProject,
  deleteProject,
  fileConversationInProject,
  listProjects,
  localProjectAssignmentsSnapshot,
  newProjectId,
  PROJECTS_CHANGED_EVENT,
  projectsWithLocalAssignments,
  reconcileLocalProjectAssignments,
  removeConversationFromProject,
  renameProject,
  subscribeLocalProjectAssignments,
} from "@/lib/projects";
import type { SidebarWorkItem } from "@/lib/sidebar-items";

/**
 * The dragged row's conversation id. A custom type (rather than text/plain) so the sidebar only
 * lights up for rows it can actually file, and so dragging a chat link into an editor still
 * produces its URL rather than an opaque id.
 */
export const CONVERSATION_DRAG_TYPE = "application/x-opencompany-conversation";

export type SidebarRowDragProps = {
  draggable?: true;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
};

export function conversationDragProps(conversationId: string): SidebarRowDragProps {
  return {
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.setData(CONVERSATION_DRAG_TYPE, conversationId);
      event.dataTransfer.effectAllowed = "move";
    },
  };
}

export function draggedConversationId(event: DragEvent<HTMLElement>) {
  return event.dataTransfer.getData(CONVERSATION_DRAG_TYPE) || null;
}

export function isConversationDrag(event: DragEvent<HTMLElement>) {
  return event.dataTransfer.types.includes(CONVERSATION_DRAG_TYPE);
}

const PROJECTS_LIST_ID = "sidebar-projects";
const SECTION_COLLAPSED_STORAGE_KEY = "opencompany-sidebar-projects-collapsed";
const COLLAPSED_STORAGE_KEY = "opencompany-sidebar-collapsed-projects";
const collapsedSubscribers = new Set<() => void>();
const NO_COLLAPSED_PROJECTS = "[]";

function subscribeCollapsedProjects(onStoreChange: () => void) {
  collapsedSubscribers.add(onStoreChange);

  function handleStorage(event: StorageEvent) {
    if (event.key === COLLAPSED_STORAGE_KEY) onStoreChange();
  }

  window.addEventListener("storage", handleStorage);
  return () => {
    collapsedSubscribers.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

// Returns the raw stored string so useSyncExternalStore can compare snapshots by identity; the
// parsed set is derived once per value in the hook below.
function getCollapsedProjectsSnapshot() {
  return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? NO_COLLAPSED_PROJECTS;
}

function getCollapsedProjectsServerSnapshot() {
  return NO_COLLAPSED_PROJECTS;
}

function parseCollapsedProjects(stored: string): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(stored);
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function useCollapsedProjects() {
  const stored = useSyncExternalStore(
    subscribeCollapsedProjects,
    getCollapsedProjectsSnapshot,
    getCollapsedProjectsServerSnapshot,
  );
  const collapsed = useMemo(() => parseCollapsedProjects(stored), [stored]);
  const toggle = useCallback(
    (projectId: string) => {
      const next = new Set(collapsed);
      if (!next.delete(projectId)) next.add(projectId);
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...next]));
      for (const subscriber of collapsedSubscribers) subscriber();
    },
    [collapsed],
  );
  return { collapsed, toggle };
}

export type SidebarProjectsState = ReturnType<typeof useSidebarProjects>;

/**
 * The reader's sidebar projects, with the conversation each one holds.
 *
 * Projects are edited by their owner in this one place and change rarely, so they are loaded over
 * REST and refreshed on focus rather than given their own live sync shape. Every mutation replies
 * with the whole list, which is what lands in state.
 */
export function useSidebarProjects(enabled: boolean) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const localAssignments = useSyncExternalStore(
    subscribeLocalProjectAssignments,
    localProjectAssignmentsSnapshot,
    localProjectAssignmentsSnapshot,
  );

  const adopt = useCallback((next: ProjectDto[]) => {
    generation.current += 1;
    setProjects(next);
    setError(null);
    setLoading(false);
    reconcileLocalProjectAssignments(next);
  }, []);

  const reload = useCallback(() => {
    if (!enabled) return;
    const request = ++generation.current;
    void listProjects()
      .then((next) => {
        if (request !== generation.current) return;
        setProjects(next);
        setError(null);
        reconcileLocalProjectAssignments(next);
      })
      .catch((cause: unknown) => {
        if (request !== generation.current) return;
        setError(cause instanceof Error ? cause.message : "Projects could not be loaded.");
      })
      .finally(() => {
        if (request === generation.current) setLoading(false);
      });
  }, [enabled]);

  useEffect(reload, [reload]);

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("focus", reload);
    window.addEventListener(PROJECTS_CHANGED_EVENT, reload);
    return () => {
      window.removeEventListener("focus", reload);
      window.removeEventListener(PROJECTS_CHANGED_EVENT, reload);
    };
  }, [enabled, reload]);

  // Every mutation returns the authoritative list, so a failed one leaves the previous list in
  // place and says what went wrong instead of guessing at a rollback.
  const mutate = useCallback(
    async (run: () => Promise<ProjectDto[]>, failure: string) => {
      try {
        adopt(await run());
        return true;
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : failure);
        return false;
      }
    },
    [adopt],
  );

  // Gated here rather than by clearing state: turning the preference off hides the section
  // immediately, and turning it back on shows the list the last load left behind.
  const visibleProjects = useMemo(
    () => (enabled ? projectsWithLocalAssignments(projects, localAssignments) : []),
    [enabled, localAssignments, projects],
  );

  const membership = useMemo(() => {
    const byConversation = new Map<string, string>();
    for (const project of visibleProjects) {
      for (const conversationId of project.conversationIds) {
        byConversation.set(conversationId, project.id);
      }
    }
    return byConversation;
  }, [visibleProjects]);

  return {
    enabled,
    projects: visibleProjects,
    loading,
    error,
    reload,
    membership,
    create: (name: string) =>
      mutate(
        () => createProject({ id: newProjectId(), name }),
        "The project could not be created.",
      ),
    rename: (projectId: string, name: string) =>
      mutate(() => renameProject(projectId, name), "The project could not be renamed."),
    remove: (projectId: string) =>
      mutate(() => deleteProject(projectId), "The project could not be deleted."),
    file: (projectId: string, conversationId: string) =>
      mutate(
        () => fileConversationInProject(projectId, conversationId),
        "That chat could not be moved.",
      ),
    unfile: (projectId: string, conversationId: string) =>
      mutate(
        () => removeConversationFromProject(projectId, conversationId),
        "That chat could not be moved out.",
      ),
  };
}

export function SidebarProjects({
  state,
  renderItem,
  itemsFor,
  activeProjectId,
}: {
  state: SidebarProjectsState;
  // Project entries are the same rows Recents renders, in the same order, so both lists behave
  // identically.
  renderItem: (item: SidebarWorkItem) => ReactNode;
  itemsFor: (project: ProjectDto) => SidebarWorkItem[];
  // The project a pending new chat is being started in, so the reader can see where it will land.
  activeProjectId: string | null;
}) {
  const { collapsed: collapsedProjects, toggle: toggleProject } = useCollapsedProjects();
  const {
    collapsed: sectionCollapsed,
    toggle: toggleSection,
    expand: expandSection,
  } = useCollapsedSidebarSection(SECTION_COLLAPSED_STORAGE_KEY);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  if (!state.enabled) return null;

  // Enter and clicking away both save, Escape discards: a half-typed name left behind by a stray
  // click is worse than either.
  const saveNewProject = async () => {
    const trimmed = name.trim();
    if (saving) return;
    if (!trimmed) {
      setCreating(false);
      return;
    }
    setSaving(true);
    const created = await state.create(trimmed);
    setSaving(false);
    if (!created) return;
    setName("");
    setCreating(false);
    // The new project's row lives below the fold, so a saved one reopens the section. Cancelling
    // leaves the reader's collapse choice alone.
    expandSection();
  };

  return (
    <section aria-label="Projects" className="pb-2">
      <SidebarSectionHeader
        label="Projects"
        collapsed={sectionCollapsed}
        onToggle={toggleSection}
        listId={PROJECTS_LIST_ID}
        action={
          <button
            type="button"
            aria-label="New project"
            title="New project"
            onClick={() => setCreating(true)}
            className={SIDEBAR_SECTION_ACTION_CLASSNAME}
          >
            <Plus size={13} strokeWidth={2} />
          </button>
        }
      />

      {creating ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveNewProject();
          }}
          className="px-2 pb-1"
        >
          <label className="sr-only" htmlFor="new-project-name">
            Project name
          </label>
          <input
            id="new-project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void saveNewProject()}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setName("");
              setCreating(false);
            }}
            autoFocus
            maxLength={80}
            placeholder="Project name"
            disabled={saving}
            className="h-7 w-full rounded-md border border-border bg-canvas px-2 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong disabled:opacity-60"
          />
        </form>
      ) : null}

      {sectionCollapsed ? null : (
        <div id={PROJECTS_LIST_ID}>
          {state.error ? (
            <div className="px-4 pb-1 text-[11.5px] leading-4">
              <p role="alert" className="text-danger">
                {state.error}
              </p>
              <button
                type="button"
                onClick={state.reload}
                className="text-ink-subtle underline hover:text-ink"
              >
                Try again
              </button>
            </div>
          ) : null}

          <div className="flex flex-col gap-px px-2">
            {state.projects.map((project) => (
              <ProjectFolder
                key={project.id}
                project={project}
                items={itemsFor(project)}
                collapsed={collapsedProjects.has(project.id)}
                onToggle={() => toggleProject(project.id)}
                active={activeProjectId === project.id}
                onDropConversation={(conversationId) => void state.file(project.id, conversationId)}
                onRename={(next) => state.rename(project.id, next)}
                onDelete={() => void state.remove(project.id)}
                renderItem={renderItem}
              />
            ))}
          </div>

          {state.loading && state.projects.length === 0 ? (
            <p role="status" className="px-4 pb-1 text-[11.5px] leading-4 text-ink-faint">
              Loading projects…
            </p>
          ) : null}
          {!state.loading && state.projects.length === 0 && !creating && !state.error ? (
            <p className="px-4 pb-1 text-[11.5px] leading-4 text-ink-faint">
              Group chats into a project to keep a thread of work together.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ProjectFolder({
  project,
  items,
  collapsed,
  onToggle,
  active,
  onDropConversation,
  onRename,
  onDelete,
  renderItem,
}: {
  project: ProjectDto;
  items: SidebarWorkItem[];
  collapsed: boolean;
  onToggle: () => void;
  active: boolean;
  onDropConversation: (conversationId: string) => void;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
  renderItem: (item: SidebarWorkItem) => ReactNode;
}) {
  const [dropTarget, setDropTarget] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const listId = `sidebar-project-${project.id}`;

  const saveRename = async () => {
    const trimmed = draftName.trim();
    if (!trimmed) {
      setDraftName(project.name);
      setRenaming(false);
      return;
    }
    if (trimmed !== project.name && !(await onRename(trimmed))) return;
    setRenaming(false);
  };

  return (
    <div>
      {renaming ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveRename();
          }}
          className="py-0.5"
        >
          <label className="sr-only" htmlFor={`${listId}-name`}>
            Project name
          </label>
          <input
            id={`${listId}-name`}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => void saveRename()}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setDraftName(project.name);
              setRenaming(false);
            }}
            autoFocus
            maxLength={80}
            className="h-7 w-full rounded-md border border-border bg-canvas px-2 text-[13px] text-ink outline-none focus:border-border-strong"
          />
        </form>
      ) : (
        <div
          onDragOver={(event) => {
            if (!isConversationDrag(event)) return;
            // Claim the drop so the browser stops showing the "no drop" cursor.
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(true);
          }}
          onDragLeave={() => setDropTarget(false)}
          onDrop={(event) => {
            setDropTarget(false);
            const conversationId = draggedConversationId(event);
            if (!conversationId) return;
            event.preventDefault();
            if (project.conversationIds.includes(conversationId)) return;
            onDropConversation(conversationId);
          }}
          className={`group/project flex items-center rounded-md text-[13px] transition-colors duration-150 ${
            dropTarget
              ? "bg-surface-active ring-1 ring-inset ring-ink/20"
              : active
                ? "bg-surface-active"
                : "hover:bg-surface-hover"
          }`}
        >
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-controls={collapsed ? undefined : listId}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-l-md py-[5px] pl-2 pr-1 text-left text-ink/90 hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <Folder
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              className="shrink-0 text-ink/60 group-hover/project:text-ink/80"
            />
            <span className="truncate tracking-[-0.005em]">{project.name}</span>
            <ChevronDown
              size={12}
              strokeWidth={2}
              aria-hidden="true"
              className={`shrink-0 text-ink/35 transition-transform duration-150 group-hover/project:text-ink/60 ${
                collapsed ? "-rotate-90" : ""
              }`}
            />
          </button>
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger
              type="button"
              aria-label={`Project options for ${project.name}`}
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink/50 transition-opacity duration-150 hover:bg-surface-active hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
                menuOpen
                  ? "opacity-100"
                  : "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100"
              }`}
            >
              <MoreHorizontal size={13} strokeWidth={1.75} />
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={4} className="w-[176px] bg-surface p-1">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setDraftName(project.name);
                  setRenaming(true);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink/90 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                <PenLine size={13} strokeWidth={1.75} className="shrink-0 text-ink/60" />
                Rename
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-danger hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                <Trash2 size={13} strokeWidth={1.75} className="shrink-0" />
                Delete project
              </button>
              <p className="px-2 pb-1 pt-1 text-[11px] leading-4 text-ink-faint">
                Deleting keeps its chats. They move back to Recents.
              </p>
            </PopoverContent>
          </Popover>
          <Link
            href={`/?project=${encodeURIComponent(project.id)}`}
            prefetch={false}
            aria-label={`New chat in ${project.name}`}
            title="New chat in this project"
            className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink/50 opacity-0 transition-opacity duration-150 hover:bg-surface-active hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 group-hover/project:opacity-100 group-focus-within/project:opacity-100"
          >
            <SquarePen size={13} strokeWidth={1.75} />
          </Link>
        </div>
      )}
      {collapsed ? null : (
        <div id={listId} className="flex flex-col gap-px">
          {items.length === 0 ? (
            <p className="py-[5px] pl-[30px] text-[12.5px] leading-4 text-ink-faint">No chats</p>
          ) : (
            items.map(renderItem)
          )}
        </div>
      )}
    </div>
  );
}
