"use client";

import { BrainCircuit, ChevronDown, ChevronRight, FileText, Folder, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { fileNameFromPath } from "@/lib/brain/file-names";
import { formatBrainRelativeTime } from "@/lib/brain/relative-time";
import {
  ancestorFolderPaths,
  type BrainTreeNode,
  buildBrainTree,
  collectFolderPaths,
} from "@/lib/brain/tree";
import type { PersonalBrainFile } from "@/lib/personal/brain";
import { MarkdownBrainEditor } from "./MarkdownBrainEditor";

// A read-only inspector for the personal agent's Memory (`memory/` bundle subtree). Memory is
// tool-managed — the agent writes it, the user only reads it — so this is a trimmed BrainView with
// no create/rename/delete/drag affordances and a non-editable content pane. It reuses the Brain
// tree utilities for the folder layout to stay visually consistent with Personal Brain.
export default function PersonalMemoryView({
  files,
  title = "Agent memory",
  emptyHint = "Your agent hasn't recorded any memory yet. As it works with you it will save what it learns here.",
}: {
  files: PersonalBrainFile[];
  title?: string;
  emptyHint?: string;
}) {
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState(files[0]?.path ?? "");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(files[0] ? ancestorFolderPaths(files[0].path) : []),
  );

  const tree = useMemo(() => buildBrainTree(files, query), [files, query]);
  const isSearching = Boolean(query.trim());
  // While searching, reveal every folder so matches deep in the tree are visible.
  const visibleExpandedPaths = useMemo(
    () => (isSearching ? new Set(collectFolderPaths(tree)) : expandedPaths),
    [isSearching, tree, expandedPaths],
  );
  const selected = files.find((file) => file.path === selectedPath) ?? null;

  function toggleFolder(path: string) {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <main className="flex h-full min-w-0 flex-1 overflow-hidden bg-canvas">
      <aside className="flex h-full w-[292px] shrink-0 flex-col border-r border-border bg-surface-muted">
        <div className="border-b border-border px-3 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.16)]">
              <BrainCircuit size={14} strokeWidth={1.9} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink">{title}</div>
              <div className="mt-0.5 text-[11.5px] text-ink-muted">
                {files.length} {files.length === 1 ? "file" : "files"} · read-only
              </div>
            </div>
          </div>
          <label className="mt-3 flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-ink-muted shadow-[0_1px_0_rgba(0,0,0,0.02)]">
            <Search size={13} strokeWidth={1.75} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search memory"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-subtle"
            />
          </label>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-3">
          {tree.children.length > 0 ? (
            <div className="space-y-px">
              {tree.children.map((node) => (
                <MemoryTreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  selectedPath={selected?.path ?? ""}
                  expandedPaths={visibleExpandedPaths}
                  onSelect={setSelectedPath}
                  onToggleFolder={toggleFolder}
                />
              ))}
            </div>
          ) : (
            <div className="px-2 py-8 text-[12.5px] leading-5 text-ink-muted">
              {files.length === 0 ? "No memory files yet." : "No files match that search."}
            </div>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle bg-canvas/85 px-5 backdrop-blur-md">
          {selected ? (
            <div className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px]">
              <div className="flex min-w-0 items-center gap-1.5">
                <FileText size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
                <span title={selected.path} className="min-w-0 truncate font-medium text-ink">
                  {fileNameFromPath(selected.path)}
                </span>
              </div>
              <span className="shrink-0 text-ink-subtle" title={selected.updatedAt}>
                Updated {formatBrainRelativeTime(selected.updatedAt)}
              </span>
            </div>
          ) : (
            <span className="text-[12.5px] text-ink-muted">No file selected</span>
          )}
        </div>

        {selected ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[860px] px-8 pb-16 pt-6">
              {isMarkdownPath(selected.path) ? (
                <MarkdownBrainEditor
                  key={selected.path}
                  content={selected.content}
                  onChange={() => {}}
                  editable={false}
                />
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-ink">
                  {selected.content}
                </pre>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-ink-muted">
            {emptyHint}
          </div>
        )}
      </section>
    </main>
  );
}

function MemoryTreeItem({
  node,
  depth,
  selectedPath,
  expandedPaths,
  onSelect,
  onToggleFolder,
}: {
  node: BrainTreeNode<PersonalBrainFile>;
  depth: number;
  selectedPath: string;
  expandedPaths: Set<string>;
  onSelect: (path: string) => void;
  onToggleFolder: (path: string) => void;
}) {
  const active = node.type === "file" && node.path === selectedPath;
  const expanded = node.type === "folder" && expandedPaths.has(node.path);
  const paddingStyle = { paddingLeft: `${6 + depth * 14}px` };

  return (
    <div>
      <button
        type="button"
        onClick={() => (node.type === "folder" ? onToggleFolder(node.path) : onSelect(node.path))}
        style={paddingStyle}
        className={`group flex w-full items-center gap-1.5 rounded-md py-[5px] pr-2 text-left text-[12.5px] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
          active
            ? "bg-surface-active text-ink"
            : "text-ink/85 hover:bg-surface-subtle hover:text-ink"
        }`}
      >
        {node.type === "folder" ? (
          expanded ? (
            <ChevronDown size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
          ) : (
            <ChevronRight size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
          )
        ) : (
          <span className="h-[13px] w-[13px] shrink-0" />
        )}
        {node.type === "folder" ? (
          <Folder size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
        ) : (
          <FileText size={13} strokeWidth={1.75} className="shrink-0 text-ink-muted" />
        )}
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
      {node.type === "folder" && expanded ? (
        <div className="space-y-px">
          {node.children.map((child) => (
            <MemoryTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggleFolder={onToggleFolder}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function isMarkdownPath(path: string) {
  return path.toLowerCase().endsWith(".md") || path.toLowerCase().endsWith(".markdown");
}
