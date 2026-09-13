import { cn } from "@opencompany/ui/lib/utils";
import { WorkspaceMockup } from "./mockups";
import { Arrow, Button } from "./primitives";
import { BODY, DISPLAY, SHELL } from "./tokens";

const CHANGELOG_URL = "https://my.opencompany.chat/changelog#release-1.26.0";

/**
 * Asymmetric hero: a 340px text column pinned to the left gutter, with the app
 * mockup starting at 38% of the shell and running off the right edge of the
 * viewport. The crop is the point — it implies the product continues past the
 * frame instead of presenting a tidy centered screenshot.
 */
export function V2Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        className={cn(
          SHELL,
          "relative flex flex-col pt-[148px] pb-24 lg:min-h-[1000px] lg:pt-[340px] lg:pb-[76px]",
        )}
      >
        <div className="max-w-[340px]">
          <h1 className={DISPLAY}>The workspace where agents run your company</h1>
          <p className={cn(BODY, "mt-5 text-pretty text-foreground/50")}>
            opencompany keeps a living model of how your company works, so agents can run real work
            across your tools, files, and codebase — not just answer questions.
          </p>
          <div className="mt-7 flex items-center gap-2">
            <Button href="/request-demo">Request demo</Button>
            <Button href="https://my.opencompany.chat" variant="secondary">
              Sign up
            </Button>
          </div>
        </div>

        {/* Mockup: in flow below the copy on small screens, lifted into the right
            half of the hero from `lg` up. One render either way. */}
        <div className="pointer-events-none relative mt-16 lg:absolute lg:top-[148px] lg:left-[38%] lg:mt-0">
          <div className="[mask-image:linear-gradient(to_bottom,black_72%,transparent_100%)]">
            <WorkspaceMockup />
          </div>
        </div>

        <a
          href={CHANGELOG_URL}
          className="mt-16 inline-flex h-7 w-fit items-center gap-2 rounded-[6px] bg-foreground/[0.04] py-2 pr-1.5 pl-3 text-[12px] transition-colors hover:bg-foreground/[0.08] lg:mt-auto"
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-violet-500" />
          <span className="text-foreground">Recent</span>
          <span className="text-foreground/50">What shipped in 1.26.0</span>
          <Arrow className="size-3 text-foreground/40" />
        </a>
      </div>
    </section>
  );
}
