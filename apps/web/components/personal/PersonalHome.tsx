"use client";

import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ModelPicker } from "@/components/agent-editor/ModelPicker";
import { Composer } from "@/components/Composer";
import { usePersonalAgent } from "@/components/personal/PersonalAgentContext";
import { PersonalInbox } from "@/components/personal/PersonalInbox";
import { useToast } from "@/components/ToastProvider";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { createAgentSessionFromPrompt } from "@/lib/agent-sessions/actions";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import { personalPaths } from "@/lib/personal/paths";

const TEXTAREA_MAX_HEIGHT_PX = 220;
const DEFAULT_MODEL_ID: AgentModelId = "openai/gpt-5.4-mini";

// The /personal default view: the inbox attention-cards prototype stacked above a hero composer
// locked to the single personal agent (no agent picker). On submit it creates a session and
// navigates to its URL.
export default function PersonalHome() {
  const { agent, userName } = usePersonalAgent();
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
      router.push(personalPaths.session(result.session.id));
    });
  };

  return (
    <main className="relative flex h-full flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
      <div className="flex w-full max-w-[600px] flex-col gap-10">
        <PersonalInbox
          userName={userName}
          onOpenSession={(id) => router.push(personalPaths.session(id))}
        />
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
      </div>
    </main>
  );
}
