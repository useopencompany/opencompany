function Block({ className = "" }: { className?: string }) {
  return <div className={`rounded-md bg-surface-subtle ${className}`} />;
}

function PageShell({
  maxWidth = "max-w-[680px]",
  children,
}: {
  maxWidth?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div
        className={`mx-auto w-full ${maxWidth} px-6 pb-16 pt-10`}
        role="status"
        aria-label="Loading"
      >
        {children}
      </div>
    </main>
  );
}

export function AgentsPageSkeleton() {
  return (
    <PageShell>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Block className="h-5 w-24" />
          <Block className="mt-3 h-3 w-full max-w-[420px]" />
          <Block className="mt-2 h-3 w-64" />
        </div>
        <Block className="h-8 w-24 shrink-0" />
      </div>
      <div className="mt-8 space-y-3">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-4 rounded-lg px-2 py-2">
            <Block className="h-[78px] w-[122px] shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <Block className="h-4 w-44" />
              <Block className="h-3 w-full max-w-[280px]" />
              <Block className="h-3 w-20" />
            </div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}

export function AgentDetailSkeleton() {
  return (
    <main className="relative flex h-full flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div
          className="mx-auto w-full max-w-[720px] px-6 pb-24 pt-10"
          role="status"
          aria-label="Loading agent"
        >
          <div className="flex items-center justify-between">
            <Block className="h-4 w-20" />
            <Block className="h-7 w-28" />
          </div>
          <Block className="mt-8 h-9 w-full max-w-[520px]" />
          <div className="mt-8 space-y-3">
            <Block className="h-4 w-full" />
            <Block className="h-4 w-11/12" />
            <Block className="h-4 w-3/4" />
          </div>
          <div className="mt-10 space-y-4">
            <Block className="h-5 w-28" />
            <Block className="h-28 w-full" />
          </div>
        </div>
      </div>
      <aside className="hidden w-[280px] shrink-0 border-l border-border bg-sidebar/60 px-4 py-5 lg:block">
        <Block className="h-4 w-24" />
        <div className="mt-5 space-y-3">
          <Block className="h-8 w-full" />
          <Block className="h-8 w-full" />
          <Block className="h-20 w-full" />
        </div>
      </aside>
    </main>
  );
}

export function SessionPageSkeleton() {
  return (
    <main className="relative flex h-full flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div
          className="mx-auto w-full max-w-[760px] px-6 pb-28 pt-6"
          role="status"
          aria-label="Loading session"
        >
          <div className="border-b border-border-subtle pb-4">
            <Block className="h-5 w-64" />
            <Block className="mt-2 h-3 w-40" />
          </div>
          <div className="mt-8 space-y-7">
            <div className="ml-auto max-w-[72%]">
              <Block className="h-20 w-full rounded-lg" />
            </div>
            <div className="max-w-[82%] space-y-2">
              <Block className="h-4 w-full" />
              <Block className="h-4 w-11/12" />
              <Block className="h-4 w-2/3" />
            </div>
            <div className="ml-auto max-w-[68%]">
              <Block className="h-14 w-full rounded-lg" />
            </div>
          </div>
        </div>
      </div>
      <aside className="hidden w-[280px] shrink-0 border-l border-border bg-sidebar/60 px-4 py-5 lg:block">
        <Block className="h-4 w-24" />
        <div className="mt-5 space-y-3">
          <Block className="h-9 w-full" />
          <Block className="h-24 w-full" />
          <Block className="h-24 w-full" />
        </div>
      </aside>
    </main>
  );
}

export function BrainPageSkeleton() {
  return (
    <main className="relative flex h-full flex-1 overflow-hidden">
      <aside className="hidden w-[260px] shrink-0 border-r border-border bg-sidebar/60 px-3 py-4 md:block">
        <Block className="h-7 w-full" />
        <div className="mt-5 space-y-2">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <Block key={row} className={`h-6 ${row % 3 === 0 ? "w-11/12" : "w-4/5"}`} />
          ))}
        </div>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div
          className="mx-auto w-full max-w-[820px] px-6 pb-24 pt-8"
          role="status"
          aria-label="Loading files"
        >
          <Block className="h-6 w-52" />
          <Block className="mt-3 h-3 w-72" />
          <div className="mt-8 space-y-3">
            <Block className="h-4 w-full" />
            <Block className="h-4 w-11/12" />
            <Block className="h-4 w-2/3" />
          </div>
          <div className="mt-10 space-y-3">
            {[0, 1, 2, 3].map((row) => (
              <Block key={row} className="h-9 w-full" />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}

export function SkillsPageSkeleton() {
  return (
    <main className="relative flex h-full flex-1 overflow-hidden">
      <aside className="hidden w-[280px] shrink-0 border-r border-border bg-surface/55 px-3 py-4 md:block">
        <div className="mb-3 flex items-center justify-between gap-3 px-1">
          <Block className="h-4 w-16" />
          <Block className="h-7 w-14" />
        </div>
        <div className="space-y-2">
          {[0, 1, 2, 3].map((row) => (
            <Block key={row} className="h-11 w-full" />
          ))}
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">
        <div
          className="mx-auto w-full max-w-[820px] px-5 pb-16 pt-8 md:px-8"
          role="status"
          aria-label="Loading skills"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <Block className="h-5 w-36" />
              <Block className="mt-2 h-3 w-52" />
            </div>
            <Block className="h-8 w-24" />
          </div>
          <div className="mt-7 space-y-4">
            <Block className="h-9 w-full" />
            <Block className="h-9 w-full" />
            <Block className="h-[420px] w-full" />
          </div>
        </div>
      </section>
    </main>
  );
}

export function SettingsPageSkeleton() {
  return (
    <PageShell maxWidth="max-w-[860px]">
      <Block className="h-6 w-28" />
      <Block className="mt-2 h-3 w-72" />
      <div className="mt-8 space-y-8">
        {[0, 1, 2].map((section) => (
          <section
            key={section}
            className="grid grid-cols-[200px_1fr] gap-8 border-t border-border-subtle pt-7 first:border-t-0 first:pt-0"
          >
            <div>
              <Block className="h-4 w-24" />
              <Block className="mt-2 h-3 w-32" />
            </div>
            <div className="space-y-3">
              <Block className="h-9 w-full" />
              <Block className="h-9 w-5/6" />
            </div>
          </section>
        ))}
      </div>
    </PageShell>
  );
}
