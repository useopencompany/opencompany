// Instant shell for the chat route. ChatPage is an async Server Component that awaits a no-store
// conversation fetch (load-bearing only for the not-found redirect), so without this boundary the
// navigation blanks until that fetch resolves. This skeleton paints the chat frame immediately; the
// live transcript then streams in from the client Electric collection once Surface mounts.
const CHAT_SKELETON_ROWS = [
  { id: "user-1", align: "end", lines: ["55%", "35%"] },
  { id: "assistant-1", align: "start", lines: ["90%", "80%", "60%"] },
  { id: "user-2", align: "end", lines: ["45%"] },
  { id: "assistant-2", align: "start", lines: ["85%", "70%"] },
] as const;

export default function ChatLoading() {
  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="min-h-0 w-full flex-1 overflow-hidden px-6">
        <div
          role="status"
          aria-label="Loading conversation"
          className="mx-auto flex w-full max-w-[720px] animate-pulse flex-col gap-6 pt-8"
        >
          {CHAT_SKELETON_ROWS.map((row) => (
            <div
              key={row.id}
              className={`flex w-full flex-col gap-2 ${
                row.align === "end" ? "items-end" : "items-start"
              }`}
            >
              {row.lines.map((width, index) => (
                <div
                  key={`${row.id}-${index}`}
                  className="h-4 rounded bg-surface-muted"
                  style={{ width }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="w-full shrink-0 px-6 pb-6">
        <div className="mx-auto w-full max-w-[720px]">
          <div className="h-[92px] w-full animate-pulse rounded-2xl border border-border bg-surface-muted" />
        </div>
      </div>
    </main>
  );
}
