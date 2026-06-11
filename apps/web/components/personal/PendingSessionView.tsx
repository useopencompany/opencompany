"use client";

import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { ArrowUp, Plus } from "lucide-react";
import { ModelPicker } from "@/components/agent-editor/ModelPicker";
import { Composer } from "@/components/Composer";
import { SessionTopBar } from "@/components/session/SessionTopBar";
import { WorkingIndicator } from "@/components/WorkingIndicator";

// The optimistic stand-in shown the instant a prompt is submitted from the personal home,
// while the create-session server action and the navigation to the real session route are
// still in flight. It mirrors SessionView's frame exactly — same top bar, transcript bubble,
// working indicator, and compact composer chrome — so the swap to the real route reads as a
// URL change, not a screen change. Everything here is inert: the composer is read-only and
// the controls are placeholders that the real view replaces within the round trip.
export function PendingSessionView({
  agentId,
  agentName,
  modelName,
  fallbackModelId,
  content,
  submittedAt,
}: {
  agentId: string;
  agentName: string;
  modelName: string;
  fallbackModelId: AgentModelId;
  content: string;
  submittedAt: string;
}) {
  return (
    <main className="relative flex h-full flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <SessionTopBar
          session={{ agentId, agentName, modelName }}
          currentContextTokens={0}
          totalCostUsdMicros={0}
          inspectorCollapsed
          onToggleInspector={() => {}}
        />

        <div className="relative flex-1 overflow-y-auto overscroll-contain [overflow-anchor:auto] px-6 py-6">
          <div className="mx-auto max-w-[960px] space-y-5">
            {/* Same min-height reserve as SessionView's active-turn box so the just-sent
                message sits at the top with room below it, exactly where the real
                transcript will render it. */}
            <div className="space-y-5" style={{ minHeight: "calc(var(--chat-vh, 100dvh) * 0.5)" }}>
              <div className="flex justify-end">
                <div className="max-w-[62%] break-words rounded-2xl rounded-tr-md bg-surface-selected px-3.5 py-2.5 text-[14px] leading-6 text-ink">
                  <div className="flex flex-col gap-2">
                    <div>{content}</div>
                  </div>
                </div>
              </div>
              <div className="flex justify-start">
                <WorkingIndicator startedAt={submittedAt} thinking={false} />
              </div>
            </div>
          </div>
        </div>

        <div className="bg-canvas px-6 py-4">
          <div className="mx-auto max-w-[960px]">
            <Composer
              variant="compact"
              input={
                <textarea
                  readOnly
                  rows={1}
                  placeholder="Ask this agent to do something"
                  className="min-h-9 w-full resize-none content-center bg-transparent text-[14px] leading-5 text-ink outline-none placeholder:text-ink-subtle"
                />
              }
              leftControls={
                <>
                  <button
                    type="button"
                    aria-label="Attach file"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink"
                  >
                    <Plus size={15} strokeWidth={1.75} />
                  </button>
                  <ModelPicker
                    value={modelName}
                    fallbackModelId={fallbackModelId}
                    onChange={() => {}}
                  />
                </>
              }
              action={
                <button
                  type="button"
                  disabled
                  aria-label="Send message"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-canvas transition-opacity hover:bg-ink/85 disabled:opacity-40"
                >
                  <ArrowUp size={13} strokeWidth={2} />
                </button>
              }
            />
          </div>
        </div>
      </div>
    </main>
  );
}
