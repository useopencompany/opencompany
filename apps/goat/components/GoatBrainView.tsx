"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { useLiveQuery } from "@tanstack/react-db";
import { ArrowLeft, FilePlus2, FolderPlus, Save, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useHydrated } from "@/components/useHydrated";
import type { GoatBrainDocumentView, GoatBrainFolderView } from "@/lib/brain";
import {
  createGoatBrainDocumentAction,
  createGoatBrainFolderAction,
  deleteGoatBrainDocumentAction,
  moveGoatBrainDocumentAction,
  updateGoatBrainDocumentAction,
} from "@/lib/brain-actions";
import {
  createGoatCollections,
  type GoatBrainDocumentRow,
  type GoatBrainFolderRow,
} from "@/lib/task-collections";

type Props = {
  folders: GoatBrainFolderView[];
  documents: GoatBrainDocumentView[];
  initialFolderPath: string | null;
  initialBrainId: string | null;
};

export function GoatBrainView({ folders, documents, initialFolderPath, initialBrainId }: Props) {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      <GoatBrainEditor
        folders={folders}
        documents={documents}
        initialFolderPath={initialFolderPath}
        initialBrainId={initialBrainId}
      />
    );
  }
  return (
    <LiveGoatBrainView
      folders={folders}
      documents={documents}
      initialFolderPath={initialFolderPath}
      initialBrainId={initialBrainId}
    />
  );
}

function LiveGoatBrainView({
  folders: initialFolders,
  documents: initialDocuments,
  initialFolderPath,
  initialBrainId,
}: Props) {
  const collections = useMemo(() => createGoatCollections(), []);
  const { data: folderRows, isLoading: foldersLoading } = useLiveQuery((q) =>
    q.from({ folder: collections.brainFolders }),
  );
  const { data: documentRows, isLoading: documentsLoading } = useLiveQuery((q) =>
    q.from({ document: collections.brainDocuments }),
  );
  const folders = useMemo(() => {
    if (foldersLoading && !folderRows?.length) return initialFolders;
    return ((folderRows ?? []) as GoatBrainFolderRow[])
      .map(folderViewFromRow)
      .toSorted((a, b) => a.path.localeCompare(b.path));
  }, [folderRows, foldersLoading, initialFolders]);
  const documents = useMemo(() => {
    if (documentsLoading && !documentRows?.length) return initialDocuments;
    return ((documentRows ?? []) as GoatBrainDocumentRow[])
      .map(documentViewFromRow)
      .toSorted(compareBrainDocuments);
  }, [documentRows, documentsLoading, initialDocuments]);

  return (
    <GoatBrainEditor
      folders={folders}
      documents={documents}
      initialFolderPath={initialFolderPath}
      initialBrainId={initialBrainId}
    />
  );
}

function GoatBrainEditor({ folders, documents, initialFolderPath, initialBrainId }: Props) {
  const router = useRouter();
  const [selectedFolder, setSelectedFolder] = useState(
    initialFolderPath ?? documents[0]?.folderPath ?? folders[0]?.path ?? "inbox",
  );
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(() => {
    const selected =
      (initialBrainId
        ? documents.find(
            (document) =>
              document.brainId === initialBrainId &&
              (!initialFolderPath || document.folderPath === initialFolderPath),
          )
        : null) ??
      documents.find((document) => document.folderPath === selectedFolder) ??
      documents[0];
    return selected?.id ?? null;
  });
  const selectedDocument = useMemo(
    () => documents.find((document) => document.id === selectedDocumentId) ?? null,
    [documents, selectedDocumentId],
  );
  const [editorValue, setEditorValue] = useState(selectedDocument?.content ?? "");
  const [newFolderPath, setNewFolderPath] = useState("");
  const [newDocumentTitle, setNewDocumentTitle] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (selectedDocumentId && documents.some((document) => document.id === selectedDocumentId)) {
      return;
    }
    const next =
      documents.find((document) => document.folderPath === selectedFolder) ?? documents[0] ?? null;
    setSelectedDocumentId(next?.id ?? null);
    if (next && next.folderPath !== selectedFolder) setSelectedFolder(next.folderPath);
  }, [documents, selectedDocumentId, selectedFolder]);

  useEffect(() => {
    setEditorValue(selectedDocument?.content ?? "");
  }, [selectedDocument?.content]);

  const folderDocuments = useMemo(
    () => documents.filter((document) => document.folderPath === selectedFolder),
    [documents, selectedFolder],
  );
  const dirty = Boolean(selectedDocument && editorValue !== selectedDocument.content);

  const selectFolder = (folderPath: string) => {
    setSelectedFolder(folderPath);
    const firstDoc = documents.find((document) => document.folderPath === folderPath);
    setSelectedDocumentId(firstDoc?.id ?? null);
    router.replace(`/brain/${folderUrlSegments(folderPath)}`);
  };

  const selectDocument = (document: GoatBrainDocumentView) => {
    setSelectedFolder(document.folderPath);
    setSelectedDocumentId(document.id);
    router.replace(brainDocumentUrl(document));
  };

  const createFolder = () => {
    const path = newFolderPath.trim();
    if (!path) return;
    startTransition(async () => {
      const result = await createGoatBrainFolderAction(path);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setNewFolderPath("");
      setSelectedFolder(result.path ?? path);
    });
  };

  const createDocument = () => {
    startTransition(async () => {
      const title = newDocumentTitle.trim();
      const result = await createGoatBrainDocumentAction({
        folderPath: selectedFolder,
        ...(title ? { title } : {}),
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const document = result.document;
      if (document) {
        setSelectedFolder(document.folderPath);
        setSelectedDocumentId(document.id);
        setEditorValue(document.content);
      }
      setNewDocumentTitle("");
      if (result.path) router.replace(result.path);
    });
  };

  const saveDocument = () => {
    if (!selectedDocument || !dirty) return;
    startTransition(async () => {
      const result = await updateGoatBrainDocumentAction({
        documentId: selectedDocument.id,
        content: editorValue,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const document = result.document;
      if (document) {
        setSelectedFolder(document.folderPath);
        setSelectedDocumentId(document.id);
        setEditorValue(document.content);
      }
      toast.success("Saved");
      if (result.path) router.replace(result.path);
    });
  };

  const moveDocument = (folderPath: string) => {
    if (!selectedDocument || folderPath === selectedDocument.folderPath) return;
    startTransition(async () => {
      const result = await moveGoatBrainDocumentAction({
        documentId: selectedDocument.id,
        folderPath,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const document = result.document;
      if (document) {
        setSelectedFolder(document.folderPath);
        setSelectedDocumentId(document.id);
        setEditorValue(document.content);
      }
      if (result.path) router.replace(result.path);
    });
  };

  const deleteDocument = () => {
    if (!selectedDocument) return;
    if (!confirm(`Delete "${selectedDocument.title ?? selectedDocument.brainId}"?`)) return;
    startTransition(async () => {
      const deletedId = selectedDocument.id;
      const result = await deleteGoatBrainDocumentAction(deletedId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const remaining = documents.filter((document) => document.id !== deletedId);
      const next =
        remaining.find((document) => document.folderPath === selectedFolder) ??
        remaining[0] ??
        null;
      setSelectedDocumentId(next?.id ?? null);
      setEditorValue(next?.content ?? "");
      if (next) router.replace(brainDocumentUrl(next));
      else router.replace(`/brain/${folderUrlSegments(selectedFolder)}`);
    });
  };

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-surface-subtle px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            aria-label="Back"
            title="Back"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <ArrowLeft size={16} strokeWidth={2} />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold leading-tight">Brain</h1>
            <p className="truncate text-[12px] leading-tight text-ink-subtle">
              {documents.length} docs · {folders.length} folders
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={saveDocument}
          disabled={!dirty || isPending}
          className="flex h-8 items-center gap-2 rounded-lg border border-surface-subtle bg-surface px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Save size={14} strokeWidth={2} />
          Save
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[180px_260px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-b border-surface-subtle bg-surface-muted md:border-b-0 md:border-r">
          <div className="flex min-h-0 flex-1 flex-row gap-1 overflow-x-auto p-2 md:flex-col md:overflow-y-auto">
            {folders.map((folder) => (
              <button
                key={folder.path}
                type="button"
                onClick={() => selectFolder(folder.path)}
                className={`flex h-8 shrink-0 items-center justify-between rounded-md px-2 text-left text-[13px] leading-none transition-colors duration-150 md:w-full ${
                  selectedFolder === folder.path
                    ? "bg-surface text-ink"
                    : "text-ink-muted hover:bg-surface-hover hover:text-ink"
                }`}
              >
                <span className="truncate">{folder.path}</span>
                {folder.source === "system" ? null : (
                  <span className="ml-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-subtle" />
                )}
              </button>
            ))}
          </div>
          <div className="flex shrink-0 gap-1 border-t border-surface-subtle p-2">
            <input
              value={newFolderPath}
              onChange={(event) => setNewFolderPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") createFolder();
              }}
              placeholder="folder"
              className="h-8 min-w-0 flex-1 rounded-md border border-surface-subtle bg-canvas px-2 text-[13px] outline-none transition-colors duration-150 placeholder:text-ink-subtle focus:border-ink/25"
            />
            <button
              type="button"
              aria-label="Create folder"
              title="Create folder"
              onClick={createFolder}
              disabled={isPending}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-45"
            >
              <FolderPlus size={15} strokeWidth={2} />
            </button>
          </div>
        </aside>

        <aside className="flex min-h-0 flex-col border-b border-surface-subtle bg-canvas md:border-b-0 md:border-r">
          <div className="flex shrink-0 gap-1 border-b border-surface-subtle p-2">
            <input
              value={newDocumentTitle}
              onChange={(event) => setNewDocumentTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") createDocument();
              }}
              placeholder="new doc"
              className="h-8 min-w-0 flex-1 rounded-md border border-surface-subtle bg-surface px-2 text-[13px] outline-none transition-colors duration-150 placeholder:text-ink-subtle focus:border-ink/25"
            />
            <button
              type="button"
              aria-label="Create document"
              title="Create document"
              onClick={createDocument}
              disabled={isPending}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink disabled:opacity-45"
            >
              <FilePlus2 size={15} strokeWidth={2} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {folderDocuments.length > 0 ? (
              <div className="flex flex-col gap-1">
                {folderDocuments.map((document) => (
                  <button
                    key={document.id}
                    type="button"
                    onClick={() => selectDocument(document)}
                    className={`rounded-md px-2 py-2 text-left transition-colors duration-150 ${
                      selectedDocumentId === document.id
                        ? "bg-surface-hover text-ink"
                        : "hover:bg-surface-hover"
                    }`}
                  >
                    <span className="block truncate text-[13px] font-medium leading-tight">
                      {document.title ?? document.brainId}
                    </span>
                    <span className="mt-1 block truncate text-[12px] leading-tight text-ink-subtle">
                      {document.brainId}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-[13px] leading-5 text-ink-subtle">
                Empty folder
              </div>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col bg-surface">
          {selectedDocument ? (
            <>
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-surface-subtle px-3 py-2">
                <div className="min-w-0">
                  <h2 className="truncate text-[14px] font-semibold leading-tight">
                    {selectedDocument.title ?? selectedDocument.brainId}
                  </h2>
                  <p className="truncate text-[12px] leading-tight text-ink-subtle">
                    {selectedDocument.folderPath}/{selectedDocument.brainId}.md
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={selectedDocument.folderPath}
                    onChange={(event) => moveDocument(event.target.value)}
                    disabled={isPending}
                    className="h-8 max-w-[180px] rounded-md border border-surface-subtle bg-canvas px-2 text-[13px] outline-none focus:border-ink/25"
                  >
                    {folders.map((folder) => (
                      <option key={folder.path} value={folder.path}>
                        {folder.path}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label="Delete document"
                    title="Delete document"
                    onClick={deleteDocument}
                    disabled={isPending}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-danger transition-colors duration-150 hover:bg-danger-bg disabled:opacity-45"
                  >
                    <Trash2 size={15} strokeWidth={2} />
                  </button>
                </div>
              </div>
              <textarea
                value={editorValue}
                onChange={(event) => setEditorValue(event.target.value)}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none bg-surface px-4 py-3 font-mono text-[13px] leading-6 text-ink outline-none"
              />
            </>
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-[14px] leading-6 text-ink-subtle">
              No document selected
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function brainDocumentUrl(document: GoatBrainDocumentView) {
  return `/brain/${folderUrlSegments(document.folderPath)}/${encodeURIComponent(document.brainId)}`;
}

function folderUrlSegments(folderPath: string) {
  return folderPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function folderViewFromRow(row: GoatBrainFolderRow): GoatBrainFolderView {
  return {
    id: row.id,
    path: row.path,
    source: row.source,
  };
}

function documentViewFromRow(row: GoatBrainDocumentRow): GoatBrainDocumentView {
  return {
    id: row.id,
    brainId: row.brain_id,
    folderPath: row.folder_path,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compareBrainDocuments(a: GoatBrainDocumentView, b: GoatBrainDocumentView) {
  const folder = a.folderPath.localeCompare(b.folderPath);
  if (folder !== 0) return folder;
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}
