import { ArrowLeft, BookOpen, ExternalLink } from "lucide-react";
import Link from "next/link";
import { JamieIntegrationSetup } from "@/components/JamieIntegrationSetup";
import { currentGoatUser } from "@/lib/auth";
import { GOAT_JAMIE_DOCS_HREF } from "@/lib/brain-sources/registry";
import { getGoatJamieIntegrationState } from "@/lib/integrations/jamie";

export const dynamic = "force-dynamic";

export default async function OnboardingJamiePage() {
  const context = await currentGoatUser();
  const state = await getGoatJamieIntegrationState(context.workspace.id);

  return (
    <main className="h-dvh w-full overflow-y-auto bg-canvas text-ink">
      <div className="mx-auto flex w-full max-w-[620px] flex-col px-6 py-10 sm:py-14">
        <Link
          href="/onboarding"
          className="mb-8 inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-ink-subtle transition-colors hover:text-ink"
        >
          <ArrowLeft size={15} strokeWidth={2} />
          Back to sources
        </Link>

        <div className="mb-8 flex flex-col gap-2">
          <h1 className="text-[24px] font-semibold text-ink">Connect Jamie</h1>
          <p className="max-w-[540px] text-[13px] leading-5 text-ink-subtle">
            Jamie uses a webhook instead of OAuth. Create the endpoint here, add it in Jamie, then
            save the API key Jamie gives you.
          </p>
          <a
            href={GOAT_JAMIE_DOCS_HREF}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex w-fit items-center gap-1.5 text-[12.5px] font-medium text-ink-muted transition-colors hover:text-ink"
          >
            <BookOpen size={14} strokeWidth={1.9} />
            Open the setup guide
            <ExternalLink size={12} strokeWidth={1.9} />
          </a>
        </div>

        <JamieIntegrationSetup initialState={state} canManage={context.role === "admin"} />

        <div className="mt-10 border-t border-border pt-6">
          <Link
            href="/onboarding"
            className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-2 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90"
          >
            <ArrowLeft size={14} strokeWidth={2} />
            Back to sources
          </Link>
        </div>
      </div>
    </main>
  );
}
