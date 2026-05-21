import AppShell from "@/components/AppShell";

export default function CompaniesPage() {
  return (
    <AppShell>
      <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-8 pb-12 pt-10">
          <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">
            Companies
          </h1>
        </div>
      </main>
    </AppShell>
  );
}
