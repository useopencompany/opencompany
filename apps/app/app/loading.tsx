export default function Loading() {
  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[560px] flex-col gap-8 pb-24 pt-16 sm:pt-24">
          <div className="h-7 w-24 rounded-md bg-surface-muted" />
          <div className="flex flex-col gap-3">
            <div className="h-4 w-28 rounded bg-surface-muted" />
            <div className="h-10 rounded-lg bg-surface-muted" />
            <div className="h-10 rounded-lg bg-surface-muted" />
            <div className="h-10 rounded-lg bg-surface-muted" />
          </div>
        </div>
      </div>
    </main>
  );
}
