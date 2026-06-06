"use client";

import { agentBundleDir } from "@opencompany/agent-runtime";
import type { AgentConfig, AgentModelId, TiptapDoc } from "@opencompany/agent-runtime/types";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, LoaderCircle, PanelLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ModelPicker } from "@/components/agent-editor/ModelPicker";
import { Composer } from "@/components/Composer";
import PersonalSidebar, { type PersonalPanel } from "@/components/PersonalSidebar";
import { PersonalBehaviorEditor } from "@/components/personal/PersonalBehaviorEditor";
import { PersonalCapabilityPanel } from "@/components/personal/PersonalCapabilityPanel";
import { PersonalContextFileEditor } from "@/components/personal/PersonalContextFileEditor";
import { PersonalInbox } from "@/components/personal/PersonalInbox";
import SessionView from "@/components/SessionView";
import { useToast } from "@/components/ToastProvider";
import { useHydrated } from "@/components/useHydrated";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { createAgentSessionFromPrompt } from "@/lib/agent-sessions/actions";
import { type SidebarSessionPayload, seedSessionQueries } from "@/lib/agent-sessions/payload";
import type { AgentBundleFilePayload } from "@/lib/agents/bundle-files";

const TEXTAREA_MAX_HEIGHT_PX = 220;
const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";
const SIDEBAR_STORAGE_KEY = "opencompany-personal-sidebar-collapsed";

type PersonalAgent = {
  id: string;
  name: string;
  defaultModel: string;
  path: string | null;
  config: AgentConfig;
  body: string;
  content: TiptapDoc;
};

// The main panel shows exactly one of: the composer (new chat), a live session, one of the
// agent-config surfaces (behavior editor / capability lists), an open context file, or the
// new-file editor for a chosen folder.
type PersonalView =
  | { kind: "inbox" }
  | { kind: "session"; sessionId: string }
  | { kind: "panel"; panel: PersonalPanel }
  | { kind: "file"; relativePath: string }
  | { kind: "newFile"; prefix: string };

export type PersonalSurfaceProps = {
  agent: PersonalAgent;
  userName: string;
  userEmail: string;
  workspaceName: string;
  initialSessions: SidebarSessionPayload[];
  contextFiles: AgentBundleFilePayload[];
};

// Composer locked to the single personal agent (no agent picker). On submit it creates a
// session and hands the id up so the surface can swap to the live chat without navigating.
// With a `header` (the inbox attention cards) it switches to a stacked layout — cards scroll
// above, the composer pins to the bottom; without one it stays the centered hero composer.
function PersonalComposer({
  agent,
  onSessionCreated,
  header,
}: {
  agent: PersonalAgent;
  onSessionCreated: (sessionId: string) => void;
  header?: React.ReactNode;
}) {
  const { workspaceId } = useWorkspaceContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { showToast } = useToast();
  const [input, setInput] = useState("");
  const [model, setModel] = useState<string>(agent.defaultModel || DEFAULT_MODEL_ID);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = Boolean(input.trim() && !isPending);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (input.length === 0) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }, [input]);

  const submit = () => {
    const content = input.trim();
    if (!content || isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await createAgentSessionFromPrompt(agent.id, content, model || undefined);
      if (!result.ok) {
        if ("redirectTo" in result) {
          router.push(result.redirectTo);
          return;
        }
        setError(result.error);
        return;
      }
      seedSessionQueries(queryClient, workspaceId, result.detail);
      onSessionCreated(result.session.id);
    });
  };

  const form = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Composer
            variant="expanded"
            error={error}
            input={
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submit();
                  }
                }}
                onPaste={(event) => {
                  const items = event.clipboardData?.items;
                  if (!items) return;
                  const itemArray = Array.from(items);
                  const hasImage = itemArray.some(
                    (item) => item.kind === "file" && item.type.startsWith("image/"),
                  );
                  if (!hasImage) return;
                  const hasText = itemArray.some((item) => item.kind === "string");
                  if (!hasText) event.preventDefault();
                  showToast({
                    title: "Image upload coming soon",
                    description: hasText
                      ? "The text was pasted; the image was ignored."
                      : "Image attachments aren't supported yet.",
                    tone: "default",
                  });
                }}
                rows={1}
                placeholder={`Message ${agent.name}`}
                className="min-h-9 w-full resize-none content-center bg-transparent text-[15px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
                style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
              />
            }
            leftControls={
              <ModelPicker
                value={model || DEFAULT_MODEL_ID}
                fallbackModelId={DEFAULT_MODEL_ID}
                onChange={(modelId) => setModel(modelId)}
              />
            }
            action={
              <button
                type="submit"
                disabled={!canSubmit}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={isPending ? "Starting session…" : "Start session"}
              >
                {isPending ? (
                  <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
                ) : (
                  <ArrowUp size={13} strokeWidth={2} />
                )}
              </button>
            }
      />
    </form>
  );

  // Inbox: attention cards sit directly above the composer, the whole group centered.
  if (header) {
    return (
      <main className="relative flex h-full flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
        <div className="flex w-full max-w-[600px] flex-col gap-10">
          {header}
          {form}
        </div>
      </main>
    );
  }

  // Bare hero composer (e.g. the deleted-file fallback): centered, no cards.
  return (
    <main className="relative flex h-full flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-[680px]">{form}</div>
    </main>
  );
}

export default function PersonalSurface({
  agent,
  userName,
  userEmail,
  workspaceName,
  initialSessions,
  contextFiles,
}: PersonalSurfaceProps) {
  const hydrated = useHydrated();
  const [view, setView] = useState<PersonalView>({ kind: "inbox" });
  const [config, setConfig] = useState<AgentConfig>(agent.config);
  const [files, setFiles] = useState<AgentBundleFilePayload[]>(contextFiles);
  const [collapsed, setCollapsed] = useState(false);

  const bundleDir = agent.path ? agentBundleDir(agent.path) : null;

  // Merge a saved/created file back into the list so the sidebar (names, counts) and the
  // open editor stay in sync without a server round-trip.
  const upsertFile = (file: AgentBundleFilePayload) => {
    setFiles((prev) => {
      const next = prev.filter((existing) => existing.path !== file.path);
      next.push(file);
      return next.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    });
  };

  // The editable behavior lives here, not just in the (immutable) `agent` prop the server
  // rendered with. The behavior editor unmounts whenever you switch panels, so its seed must
  // reflect the latest edit — otherwise remounting reseeds it from stale server props and the
  // change appears lost until a full reload. A ref (not state) keeps this re-render-free: the
  // editor owns its own DOM, and renderMain() reads the current draft when it remounts.
  const draftRef = useRef<{ body: string; content: TiptapDoc }>({
    body: agent.body,
    content: agent.content,
  });

  // Restore the persisted collapse preference once on the client. SSR/first render stays
  // expanded so the markup matches the server HTML, then snaps to the stored value.
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true");
  }, []);

  const updateCollapsed = (next: boolean) => {
    setCollapsed(next);
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
  };

  const sessionId = view.kind === "session" ? view.sessionId : null;
  const activePanel = view.kind === "panel" ? view.panel : null;
  const activeFilePath = view.kind === "file" ? view.relativePath : null;

  const activeFile = useMemo(
    () => (activeFilePath ? files.find((file) => file.relativePath === activeFilePath) : undefined),
    [activeFilePath, files],
  );

  const renderMain = () => {
    if (view.kind === "newFile") {
      return (
        <div className="h-full overflow-hidden">
          <PersonalContextFileEditor
            agentId={agent.id}
            bundleDir={bundleDir}
            newFilePrefix={view.prefix}
            onSaved={upsertFile}
            onCreated={(file) => {
              upsertFile(file);
              setView({ kind: "file", relativePath: file.relativePath });
            }}
          />
        </div>
      );
    }
    if (view.kind === "file") {
      // The file may have been deleted out from under us; fall back to the inbox.
      if (!activeFile) {
        return (
          <PersonalComposer
            agent={agent}
            onSessionCreated={(id) => setView({ kind: "session", sessionId: id })}
          />
        );
      }
      return (
        <div className="h-full overflow-hidden">
          <PersonalContextFileEditor
            agentId={agent.id}
            bundleDir={bundleDir}
            file={activeFile}
            onSaved={upsertFile}
            onCreated={(file) => setView({ kind: "file", relativePath: file.relativePath })}
          />
        </div>
      );
    }
    if (activePanel === "behavior") {
      return (
        <div className="h-full overflow-y-auto">
          <PersonalBehaviorEditor
            agentId={agent.id}
            initialBody={draftRef.current.body || config.instructions}
            initialContent={draftRef.current.content}
            config={config}
            onConfigChange={setConfig}
            onDraftChange={(body, content) => {
              draftRef.current = { body, content };
            }}
          />
        </div>
      );
    }
    if (activePanel) {
      return (
        <div className="h-full overflow-y-auto">
          <PersonalCapabilityPanel section={activePanel} config={config} />
        </div>
      );
    }
    // SessionView relies on useLiveQuery (client-only); keep the composer SSR-safe until hydrated.
    if (hydrated && sessionId) {
      return <SessionView sessionId={sessionId} />;
    }
    return (
      <PersonalComposer
        agent={agent}
        onSessionCreated={(id) => setView({ kind: "session", sessionId: id })}
        header={
          <PersonalInbox
            userName={userName}
            sessionIds={initialSessions.map((session) => session.id)}
            onOpenSession={(id) => setView({ kind: "session", sessionId: id })}
          />
        }
      />
    );
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-sidebar">
      <PersonalSidebar
        agentId={agent.id}
        agentName={agent.name}
        agentPath={agent.path}
        userName={userName}
        userEmail={userEmail}
        workspaceName={workspaceName}
        initialSessions={initialSessions}
        contextFiles={files}
        config={config}
        activeSessionId={sessionId}
        activePanel={activePanel}
        activeFilePath={activeFilePath}
        collapsed={collapsed}
        onToggleCollapsed={() => updateCollapsed(!collapsed)}
        onNewSession={() => setView({ kind: "inbox" })}
        onSelectSession={(id) => setView({ kind: "session", sessionId: id })}
        onSelectPanel={(panel) => setView({ kind: "panel", panel })}
        onSelectFile={(relativePath) => setView({ kind: "file", relativePath })}
        onNewFile={(prefix) => setView({ kind: "newFile", prefix })}
      />

      {/* When the sidebar is expanded the main view floats as a rounded panel so the
          sidebar canvas peeks around its edges; collapsed, it bleeds to full screen. */}
      <div
        className={`relative flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas transition-[margin,border-radius] duration-200 ease-out ${
          collapsed
            ? "m-0 rounded-none border-0"
            : "my-2 mr-2 rounded-xl border border-border shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
        }`}
      >
        {collapsed && (
          <button
            type="button"
            aria-label="Expand sidebar"
            aria-expanded={false}
            onClick={() => updateCollapsed(false)}
            className="fixed left-2 top-3 z-50 rounded-md border border-border bg-canvas/85 p-1.5 text-ink/60 shadow-[0_1px_2px_rgba(15,15,15,0.04)] backdrop-blur-md transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <PanelLeft size={15} strokeWidth={1.75} />
          </button>
        )}
        {renderMain()}
      </div>
    </div>
  );
}
