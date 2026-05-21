import { ArrowRight, GitBranch } from "lucide-react";

export default function LoginPanel() {
  return (
    <main className="flex h-screen w-screen bg-canvas">
      <section className="mx-auto flex w-full max-w-[680px] flex-col px-6 pt-[18vh]">
        <div className="mb-3 flex items-center gap-1">
          <span className="flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] text-ink/90">
            <GitBranch size={13} strokeWidth={1.75} className="text-ink-muted" />
            main
          </span>
        </div>

        <div className="rounded-xl border border-[#e4e4e0] bg-white px-4 pb-3 pt-3.5 shadow-[0_1px_2px_rgba(15,15,15,0.03),0_0_0_1px_rgba(15,15,15,0.01)]">
          <div className="text-[14px] leading-6 tracking-[-0.005em] text-ink">
            Sign in to open your workspace
          </div>
          <div className="mt-6 flex items-center">
            <div className="flex min-w-0 flex-col">
              <span className="text-[12.5px] font-medium text-ink/90">
                Open Company
              </span>
              <span className="text-[11px] text-ink-subtle">
                One workspace will be created automatically
              </span>
            </div>
            <a
              href="/auth/sign-in"
              className="ml-auto flex h-7 items-center gap-1.5 rounded-full bg-[#111] px-3 text-[12px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
            >
              <span>Sign in</span>
              <ArrowRight size={12} strokeWidth={2} />
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
