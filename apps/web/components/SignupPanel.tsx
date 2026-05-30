"use client";

import { captureEvent } from "@opencompany/analytics/client";
import { ArrowRight, Building2, LogIn } from "lucide-react";

export default function SignupPanel() {
  return (
    <main className="flex min-h-screen w-screen bg-canvas px-5">
      <section className="mx-auto flex w-full max-w-[420px] flex-col pb-10 pt-[16vh] sm:pt-[20vh]">
        <div className="mb-3 flex items-center gap-1 text-[12.5px]">
          <span className="flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-ink/90">
            <Building2 size={13} strokeWidth={1.75} className="text-ink-muted" />
            opencompany
          </span>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-[0_1px_2px_rgba(15,15,15,0.03),0_0_0_1px_rgba(15,15,15,0.01)]">
          <div className="px-4 pb-4 pt-4">
            <h1 className="text-[16px] font-semibold leading-6 text-ink">
              Sign up for opencompany
            </h1>
            <p className="mt-1.5 text-[12.5px] leading-5 text-ink-muted">
              Set up a focused place for your team context, agents, and sessions. New accounts
              include $3 in free credits.
            </p>

            <a
              href="/auth/sign-up"
              onClick={() => captureEvent("signup_started", { entrypoint: "signup_page" })}
              className="mt-5 flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-[12px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
            >
              <span>Sign up</span>
              <ArrowRight size={12} strokeWidth={2} />
            </a>
          </div>

          <div className="flex items-center justify-between border-t border-border-subtle px-4 py-3">
            <span className="text-[11.5px] text-ink-subtle">Already have an account?</span>
            <a
              href="/auth/sign-in"
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <LogIn size={12} strokeWidth={2} className="text-ink-muted" />
              <span>Sign in</span>
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
