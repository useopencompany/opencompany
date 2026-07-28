import Link from "next/link";
import { GoatWorkflowEditorRoute } from "@/components/GoatRoutes";
import { currentGoatUser } from "@/lib/auth";
import { getGoatWorkflow, listGoatWorkflows } from "@/lib/workflows";

type WorkflowEditorPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function WorkflowEditorPage({ params }: WorkflowEditorPageProps) {
  const { slug } = await params;
  const context = await currentGoatUser();
  const [workflow, list] = await Promise.all([
    getGoatWorkflow(context.workspace.id, slug),
    listGoatWorkflows(context.workspace.id),
  ]);

  if (!workflow) {
    return (
      <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
        <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
          <div className="flex w-full max-w-[760px] flex-col gap-4 pb-24 pt-16 sm:pt-24">
            <Link
              href="/workflows"
              prefetch
              className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              Workflows
            </Link>
            <h1 className="text-[24px] font-semibold leading-tight text-ink">Workflow not found</h1>
            <p className="text-[13px] leading-5 text-ink-subtle">
              This workflow may have been archived or never existed.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const status = list.find((item) => item.slug === slug)?.status ?? "draft";

  return (
    <GoatWorkflowEditorRoute
      workflow={workflow}
      initialStatus={status}
      canEdit={context.role === "admin"}
    />
  );
}
