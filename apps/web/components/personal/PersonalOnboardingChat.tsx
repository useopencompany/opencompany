"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Composer } from "@/components/Composer";
import { useToast } from "@/components/ToastProvider";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { createPersonalOnboardingSession } from "@/lib/agent-sessions/actions";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import { resetPersonalAgent } from "@/lib/personal/actions";
import { personalPaths } from "@/lib/personal/paths";

const TEXTAREA_MAX_HEIGHT_PX = 220;

type PersonalOnboardingChatProps = {
  agentId: string;
  devReset: boolean;
};

// The V2 onboarding chatbox: one identity question and the personal agent's composer — no sidebar,
// inbox, model picker, prompt chips, or welcome copy. Submitting seeds the intro into an onboarding
// session (the agent does the personalized greeting + tailored suggestions in its first reply) and
// lands the user in the real /personal session view.
export function PersonalOnboardingChat({ agentId, devReset }: PersonalOnboardingChatProps) {
  const { workspaceId } = useWorkspaceContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { showToast, showError } = useToast();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isResetting, startResetTransition] = useTransition();
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
      const result = await createPersonalOnboardingSession(agentId, content);
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

  const reset = () => {
    if (isResetting) return;
    startResetTransition(async () => {
      const result = await resetPersonalAgent();
      if (!result.ok) {
        showError(result.error, "Could not reset agent");
        return;
      }
      setInput("");
      showToast({ title: "Personal agent reset", tone: "default" });
      // Re-run the server layout/page so ensurePersonalAgent provisions a fresh agent.
      router.refresh();
    });
  };

  return (
    <main className="relative flex h-screen w-screen flex-col items-center justify-center overflow-y-auto bg-canvas px-6 py-10">
      <div className="flex w-full max-w-[600px] flex-col gap-6">
        <h1 className="text-center text-[22px] font-medium tracking-[-0.01em] text-ink">
          Before we start — what's your name, what do you do, and what are you building?
        </h1>

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
                placeholder="e.g. I'm Alex, I run growth at Acme (acme.com) — we sell…"
                className="min-h-9 w-full resize-none content-center bg-transparent text-[15px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
                style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
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

      {devReset ? (
        <button
          type="button"
          onClick={reset}
          disabled={isResetting}
          className="fixed bottom-4 right-4 flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-subtle/70 transition-colors duration-150 hover:text-ink disabled:opacity-50"
          aria-label="Reset personal agent (dev only)"
        >
          {isResetting ? (
            <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />
          ) : null}
          Reset agent
        </button>
      ) : null}
    </main>
  );
}
