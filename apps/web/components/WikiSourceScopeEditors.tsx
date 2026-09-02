"use client";

import type { WikiSourceDto } from "@opencompany/protocol";
import { useMemo, useState, useTransition } from "react";

type WikiSourceScopeEditorProps = {
  integrationId: string;
  source: WikiSourceDto | null;
  onSave: (config: Record<string, unknown>) => Promise<boolean>;
};

type GmailEventSelection = "email_received" | "email_sent";

const GMAIL_EVENT_OPTIONS: Array<{ id: GmailEventSelection; label: string }> = [
  { id: "email_received", label: "Email received" },
  { id: "email_sent", label: "Email sent" },
];

const GMAIL_INSTRUCTIONS_MAX_LENGTH = 2000;
const GMAIL_DEFAULT_INSTRUCTIONS =
  "Ignore transactional emails, spam, and personal emails. Only ingest emails that directly relate to our company.";

function gmailEventsFromConfig(config: Record<string, unknown> | undefined): GmailEventSelection[] {
  const value = config?.events;
  if (!Array.isArray(value)) return GMAIL_EVENT_OPTIONS.map((option) => option.id);
  const allowed = new Set(GMAIL_EVENT_OPTIONS.map((option) => option.id));
  const seen = new Set<GmailEventSelection>();
  for (const entry of value) {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (typeof id === "string" && allowed.has(id as GmailEventSelection)) {
      seen.add(id as GmailEventSelection);
    }
  }
  return [...seen];
}

function gmailInstructionsFromConfig(config: Record<string, unknown> | undefined) {
  return typeof config?.instructions === "string" ? config.instructions : "";
}

export function WikiGmailSourceEditor({
  integrationId,
  source,
  onSave,
}: WikiSourceScopeEditorProps) {
  const savedEvents = useMemo(() => gmailEventsFromConfig(source?.config), [source?.config]);
  const savedInstructions = useMemo(
    () => gmailInstructionsFromConfig(source?.config),
    [source?.config],
  );
  const isNewSource = !source;
  const [expanded, setExpanded] = useState(false);
  const [eventSelection, setEventSelection] = useState<Set<GmailEventSelection>>(
    () => new Set(savedEvents),
  );
  const [instructions, setInstructions] = useState(
    isNewSource ? GMAIL_DEFAULT_INSTRUCTIONS : savedInstructions,
  );
  const [dirty, setDirty] = useState(isNewSource);
  const [isPending, startTransition] = useTransition();

  const toggleEvent = (eventId: GmailEventSelection) => {
    setDirty(true);
    setEventSelection((current) => {
      const next = new Set(current);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const save = () => {
    startTransition(async () => {
      const saved = await onSave({
        events: [...eventSelection].map((id) => ({ id })),
        instructions,
      });
      if (saved) setDirty(false);
    });
  };

  const selectedLabels = GMAIL_EVENT_OPTIONS.filter((option) => eventSelection.has(option.id)).map(
    (option) => option.label.toLowerCase(),
  );
  const summary =
    selectedLabels.length === 0
      ? "No email events selected yet — nothing is ingested until you choose some."
      : `Ingesting ${selectedLabels.join(" and ")}${
          instructions.trim() ? ", tuned by your instructions" : ""
        }.`;

  if (!expanded) {
    return (
      <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-2">
        <p className="text-[11.5px] leading-4 text-ink-subtle">{summary}</p>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="shrink-0 rounded-md border border-ink/15 px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover"
        >
          Choose events and instructions
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border/70 pt-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-ink">Email ingestion</span>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
        >
          Collapse
        </button>
      </div>
      <div className="flex flex-col gap-1 rounded-md border border-ink/10 p-1">
        <div className="px-1 py-0.5 text-[12px] font-medium text-ink">Events</div>
        <div className="grid grid-cols-1 gap-px sm:grid-cols-2">
          {GMAIL_EVENT_OPTIONS.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
            >
              <input
                type="checkbox"
                checked={eventSelection.has(option.id)}
                onChange={() => toggleEvent(option.id)}
                className="accent-ink"
              />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`wiki-gmail-instructions-${integrationId}`}
          className="px-1 text-[12px] font-medium text-ink"
        >
          Ingestion instructions (optional)
        </label>
        <textarea
          id={`wiki-gmail-instructions-${integrationId}`}
          value={instructions}
          maxLength={GMAIL_INSTRUCTIONS_MAX_LENGTH}
          rows={3}
          onChange={(event) => {
            setInstructions(event.target.value);
            setDirty(true);
          }}
          placeholder="Ignore transactional and automated messages; only capture investor and customer emails."
          className="w-full resize-y rounded-md border border-ink/10 bg-transparent px-2 py-1.5 text-[12.5px] leading-5 text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        />
        <p className="px-1 text-[11.5px] leading-4 text-ink-subtle">
          Tell the librarian what matters in your inbox. It reads selected email events and uses
          these instructions during cheap triage and full ingestion.
        </p>
      </div>
      <p className="text-[11.5px] leading-4 text-ink-subtle">
        Ingested email content — including what other people write to you — becomes visible to
        everyone with access to this Wiki.
      </p>
      {dirty ? (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={isPending}
            onClick={save}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
          >
            {isPending ? "Saving…" : "Save Gmail source"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
