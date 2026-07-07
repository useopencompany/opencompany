import { ArrowLeft, FileText } from "lucide-react";
import Link from "next/link";
import { JamieIntegrationSetup } from "@/components/JamieIntegrationSetup";
import { currentGoatUser } from "@/lib/auth";
import { getGoatJamieIntegrationState } from "@/lib/integrations/jamie";

export const dynamic = "force-dynamic";

export default async function JamieSettingsPage() {
  const { user } = await currentGoatUser();
  const state = await getGoatJamieIntegrationState(user.workosUserId);

  return (
    <main className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[560px] flex-col gap-8 pb-24 pt-16 sm:pt-24">
          <Link
            href="/settings"
            className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <ArrowLeft size={14} strokeWidth={2} />
            Settings
          </Link>

          <header className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-ink">
              <FileText size={21} strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-[34px] font-semibold leading-tight tracking-normal text-ink">
                Jamie
              </h1>
              <p className="text-[13px] leading-5 text-ink-subtle">Meeting notes for Goat Brain</p>
            </div>
          </header>

          <JamieIntegrationSetup initialState={state} />
        </div>
      </div>
    </main>
  );
}
