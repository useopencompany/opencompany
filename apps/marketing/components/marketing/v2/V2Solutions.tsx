import { cn } from "@opencompany/ui/lib/utils";
import { Panel, ReviewMockup, WikiMockup, WorkflowMockup } from "./mockups";
import { Micro, Section } from "./primitives";
import { BODY, GRID } from "./tokens";

const SOLUTIONS = [
  {
    title: "Ship from the backlog",
    body: "Turn a bug report or a feature idea into a pull request you can review. The work runs on your coding agent, in a cloud sandbox, with your codebase and conventions already loaded.",
    replaces: "Replaces: re-explaining the codebase to every new session",
    Mockup: ReviewMockup,
  },
  {
    title: "Keep the company's context current",
    body: "The wiki compiles itself from Slack, GitHub, Linear, and Gmail. Decisions, shipped work, and open threads stay findable without anyone stopping to write them down.",
    replaces: "Replaces: the doc that went stale in week three",
    Mockup: WikiMockup,
  },
  {
    title: "Hand off the work you repeat",
    body: "Move recurring processes into workflows — bug triage, outreach drafts, weekly updates — and run them on a trigger or on demand. Every run is inspectable.",
    replaces: "Replaces: the Monday morning checklist",
    Mockup: WorkflowMockup,
  },
];

/**
 * Three solution rows on the shared 12-column grid: a 340px text column in the
 * left gutter and a cropped product panel filling columns 5–12.
 */
export function V2Solutions() {
  return (
    <Section title="What teams do with opencompany" eyebrow="Solutions" index="1.0">
      <div className="space-y-24 sm:space-y-32">
        {SOLUTIONS.map(({ title, body, replaces, Mockup }) => (
          <div key={title} className={GRID}>
            <div className="col-span-12 flex flex-col sm:col-span-4">
              <h3 className={cn(BODY, "text-foreground")}>{title}</h3>
              <p className={cn(BODY, "mt-2 max-w-[340px] text-foreground/50")}>{body}</p>
              <Micro className="mt-8 sm:mt-auto sm:pt-16">{replaces}</Micro>
            </div>
            <Panel className="col-span-12 mt-8 sm:col-span-8 sm:col-start-5 sm:mt-0">
              <Mockup />
            </Panel>
          </div>
        ))}
      </div>
    </Section>
  );
}
