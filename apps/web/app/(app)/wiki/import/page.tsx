import { WikiImport } from "@/components/BrainImport";
import { currentUser } from "@/lib/auth";

export default async function WikiImportPage() {
  const { workspace, role } = await currentUser();

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-5 py-8 sm:px-8 sm:py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-ink">
            Import company context
          </h1>
          <p className="mt-1 text-[13px] leading-5 text-ink-subtle">
            Discover public and connected-source context, review the workload, then create company
            and people pages in your Wiki.
          </p>
        </div>
        {role === "admin" ? (
          <WikiImport workspaceId={workspace.id} />
        ) : (
          <p className="rounded-lg border border-border bg-surface p-4 text-[13px] text-ink-muted">
            Only workspace admins can import company context.
          </p>
        )}
      </div>
    </main>
  );
}
