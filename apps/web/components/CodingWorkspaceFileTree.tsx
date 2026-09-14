"use client";

import { cn } from "@opencompany/ui/lib/utils";
import {
  Braces,
  ChevronRight,
  FileCode,
  FileCog,
  File as FileIcon,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef } from "react";
import type { WorkspaceFileEntry } from "@/lib/coding-workspace-files";

export type WorkspaceDirectoryState =
  | { status: "loading" }
  | { status: "ready"; entries: WorkspaceFileEntry[]; truncated: boolean }
  | { status: "error"; message: string };

export type WorkspaceTreeRow = { entry: WorkspaceFileEntry; depth: number };

export function CodingWorkspaceFileTree({
  rootLabel,
  directories,
  expandedPaths,
  selectedPath,
  unsavedPaths,
  activePath,
  onActivePathChange,
  onToggleDirectory,
  onOpenFile,
}: {
  rootLabel: string;
  directories: ReadonlyMap<string, WorkspaceDirectoryState>;
  expandedPaths: ReadonlySet<string>;
  selectedPath: string | null;
  unsavedPaths: ReadonlySet<string>;
  activePath: string | null;
  onActivePathChange: (path: string) => void;
  onToggleDirectory: (path: string, expand: boolean) => void;
  onOpenFile: (path: string) => void;
}) {
  const rows = useMemo(() => flattenTree(directories, expandedPaths), [directories, expandedPaths]);
  const root = directories.get("");
  // The row that owns the tree's single tab stop, so Tab lands where the user left off.
  const focusPath = rows.some((row) => row.entry.path === activePath)
    ? activePath
    : (rows[0]?.entry.path ?? null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedPath) return;
    listRef.current
      ?.querySelector(`[data-tree-path="${CSS.escape(selectedPath)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedPath]);

  const focusRow = (path: string) => {
    onActivePathChange(path);
    listRef.current?.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(path)}"]`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.entry.path === focusPath);
    const row = rows[index];
    if (!row) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      focusRow(next.entry.path);
    } else if (event.key === "Home" || event.key === "End") {
      const next = event.key === "Home" ? rows[0] : rows.at(-1);
      if (!next) return;
      event.preventDefault();
      focusRow(next.entry.path);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (row.entry.type !== "directory") return;
      if (!expandedPaths.has(row.entry.path)) {
        onToggleDirectory(row.entry.path, true);
        return;
      }
      const firstChild = rows[index + 1];
      if (firstChild?.depth === row.depth + 1) focusRow(firstChild.entry.path);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.entry.type === "directory" && expandedPaths.has(row.entry.path)) {
        onToggleDirectory(row.entry.path, false);
        return;
      }
      const parent = rows
        .slice(0, index)
        .reverse()
        .find((candidate) => candidate.depth === row.depth - 1);
      if (parent) focusRow(parent.entry.path);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (row.entry.type === "directory") {
        onToggleDirectory(row.entry.path, !expandedPaths.has(row.entry.path));
      } else {
        onOpenFile(row.entry.path);
      }
    }
  };

  if (root?.status === "loading") {
    return <TreeNotice busy>Reading {rootLabel}…</TreeNotice>;
  }
  if (root?.status === "error") {
    return <TreeNotice>{root.message}</TreeNotice>;
  }
  if (root?.status === "ready" && root.entries.length === 0) {
    return <TreeNotice>{rootLabel} is empty. Ask the agent to clone a repository here.</TreeNotice>;
  }

  return (
    <div
      ref={listRef}
      // biome-ignore lint/a11y/useSemanticElements: a flattened tree needs role="tree".
      role="tree"
      aria-label={`${rootLabel} files`}
      className="min-h-0 flex-1 overflow-auto py-1"
      onKeyDown={onKeyDown}
    >
      {rows.map((row) => {
        const isDirectory = row.entry.type === "directory";
        const isExpanded = isDirectory && expandedPaths.has(row.entry.path);
        const state = isExpanded ? directories.get(row.entry.path) : undefined;
        return (
          <div key={row.entry.path}>
            <button
              type="button"
              role="treeitem"
              data-tree-path={row.entry.path}
              aria-level={row.depth + 1}
              aria-selected={row.entry.path === selectedPath}
              aria-expanded={isDirectory ? isExpanded : undefined}
              tabIndex={row.entry.path === focusPath ? 0 : -1}
              title={row.entry.path}
              onFocus={() => onActivePathChange(row.entry.path)}
              onClick={() =>
                isDirectory
                  ? onToggleDirectory(row.entry.path, !isExpanded)
                  : onOpenFile(row.entry.path)
              }
              className={cn(
                "flex h-[26px] w-full items-stretch rounded-[5px] pr-2 text-left text-[12px] outline-none",
                row.entry.path === selectedPath
                  ? "bg-surface-active text-ink"
                  : "text-ink-muted hover:bg-surface-hover hover:text-ink",
                "focus-visible:ring-1 focus-visible:ring-border-strong",
              )}
            >
              {/* Indent guides make deep nesting scannable without counting pixels. */}
              {Array.from({ length: row.depth }, (_, depth) => (
                <span
                  key={depth}
                  aria-hidden
                  className="ml-[11px] w-[9px] shrink-0 border-border-subtle border-l"
                />
              ))}
              <span className="flex min-w-0 flex-1 items-center gap-1 pl-1.5">
                {isDirectory ? (
                  <ChevronRight
                    size={12}
                    aria-hidden
                    className={cn(
                      "shrink-0 text-ink-faint transition-transform",
                      isExpanded && "rotate-90",
                    )}
                  />
                ) : (
                  <span aria-hidden className="w-3 shrink-0" />
                )}
                <EntryIcon entry={row.entry} expanded={isExpanded} />
                <span className="truncate">{row.entry.name}</span>
                {unsavedPaths.has(row.entry.path) ? (
                  <span
                    title="Unsaved changes"
                    className="ml-auto size-1.5 shrink-0 rounded-full bg-ink-muted"
                  />
                ) : null}
              </span>
            </button>
            {state?.status === "loading" ? (
              <p
                className="py-0.5 text-[11px] text-ink-faint"
                style={{ paddingLeft: 20 + row.depth * 9 }}
              >
                Loading…
              </p>
            ) : null}
            {state?.status === "error" ? (
              <p
                className="py-0.5 text-[11px] text-danger"
                style={{ paddingLeft: 20 + row.depth * 9 }}
              >
                {state.message}
              </p>
            ) : null}
            {state?.status === "ready" && state.entries.length === 0 ? (
              <p
                className="py-0.5 text-[11px] text-ink-faint"
                style={{ paddingLeft: 20 + row.depth * 9 }}
              >
                Empty
              </p>
            ) : null}
            {state?.status === "ready" && state.truncated ? (
              <p
                className="py-0.5 text-[11px] text-ink-faint"
                style={{ paddingLeft: 20 + row.depth * 9 }}
              >
                Showing the first {state.entries.length} entries
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function flattenTree(
  directories: ReadonlyMap<string, WorkspaceDirectoryState>,
  expandedPaths: ReadonlySet<string>,
): WorkspaceTreeRow[] {
  const rows: WorkspaceTreeRow[] = [];
  const walk = (directoryPath: string, depth: number) => {
    const state = directories.get(directoryPath);
    if (state?.status !== "ready") return;
    for (const entry of state.entries) {
      rows.push({ entry, depth });
      if (entry.type === "directory" && expandedPaths.has(entry.path)) {
        walk(entry.path, depth + 1);
      }
    }
  };
  walk("", 0);
  return rows;
}

function EntryIcon({ entry, expanded }: { entry: WorkspaceFileEntry; expanded: boolean }) {
  const Icon =
    entry.type === "directory"
      ? expanded
        ? FolderOpen
        : Folder
      : FILE_ICONS[fileIconKind(entry.name)];
  return <Icon size={13} aria-hidden className="shrink-0 text-ink-faint" />;
}

const FILE_ICONS = {
  code: FileCode,
  config: FileCog,
  data: Braces,
  image: FileImage,
  plain: FileIcon,
  text: FileText,
} as const;

const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "jsx",
  "kt",
  "less",
  "lua",
  "mjs",
  "cjs",
  "php",
  "py",
  "r",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "ts",
  "tsx",
  "vue",
  "zsh",
]);
const DATA_EXTENSIONS = new Set(["json", "jsonc", "toml", "xml", "yaml", "yml"]);
const TEXT_EXTENSIONS = new Set(["csv", "log", "markdown", "md", "mdx", "txt"]);
const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

function fileIconKind(name: string): keyof typeof FILE_ICONS {
  const lower = name.toLowerCase();
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (DATA_EXTENSIONS.has(extension)) return "data";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (lower.startsWith(".") || lower.startsWith("dockerfile") || lower === "makefile") {
    return "config";
  }
  return "plain";
}

function TreeNotice({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 items-start gap-2 px-3 py-4 text-[12px] text-ink-subtle">
      {busy ? <LoaderCircle size={13} className="mt-0.5 shrink-0 animate-spin" /> : null}
      <p className="leading-5">{children}</p>
    </div>
  );
}
