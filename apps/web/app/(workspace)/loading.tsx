export default function WorkspaceLoading() {
  return (
    <main className="relative flex h-full flex-1 flex-col overflow-hidden">
      <div className="border-b border-[#eaeae6] bg-canvas/90 px-6 py-3">
        <div className="h-4 w-32 rounded bg-[#e5e5e1]" />
      </div>
      <div className="mx-auto w-full max-w-[760px] px-8 py-8" role="status" aria-label="Loading">
        <div className="space-y-4">
          <div className="h-5 w-44 rounded bg-[#e5e5e1]" />
          <div className="h-20 rounded-lg border border-[#e4e4e0] bg-white/50" />
          <div className="h-20 rounded-lg border border-[#e4e4e0] bg-white/50" />
        </div>
      </div>
    </main>
  );
}
