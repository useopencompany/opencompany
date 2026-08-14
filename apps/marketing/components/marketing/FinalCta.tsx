import { Cta } from "./Cta";
import { GridBackdrop } from "./GridBackdrop";

export function FinalCta() {
  return (
    <section className="relative overflow-hidden border-border border-t">
      <div className="relative mx-auto max-w-5xl px-6 py-24 text-center">
        <GridBackdrop />
        <h2 className="relative text-balance font-medium font-mono text-3xl text-ink leading-[1.1] tracking-tight sm:text-4xl">
          Start your first task.
        </h2>
        <p className="relative mt-4 font-medium font-mono text-[15px] text-ink-subtle leading-7 opacity-60">
          Your wiki builds itself on sign-up.
        </p>
        <div className="relative mt-9 flex items-center justify-center">
          <Cta href="https://my.opencompany.chat" analyticsIntent="signup">
            Sign up
          </Cta>
        </div>
      </div>
    </section>
  );
}
