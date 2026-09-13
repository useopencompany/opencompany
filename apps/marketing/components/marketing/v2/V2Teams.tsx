"use client";

import { cn } from "@opencompany/ui/lib/utils";
import { useState } from "react";
import { ChatMockup, Panel } from "./mockups";
import { Section } from "./primitives";
import { BODY, GRID } from "./tokens";

type Team = {
  role: string;
  question: string;
  answer: string;
  bullets: string[];
  closing: string;
};

/**
 * Typed as a non-empty tuple so `TEAMS[0]` is a guaranteed fallback under
 * `noUncheckedIndexedAccess` — one role is always selected.
 */
const TEAMS: [Team, ...Team[]] = [
  {
    role: "Founders",
    question: "What did we decide about pricing, and why?",
    answer: "Usage-based, decided on 14 August. Three threads drove it.",
    bullets: [
      "Two design partners were adding agents faster than headcount, so per-seat punished the behaviour we want.",
      "Support saw four tickets about seat limits blocking a run mid-task.",
    ],
    closing:
      "The open question is top-ups: BIL-204 is still unassigned and blocks the Pro launch checklist.",
  },
  {
    role: "Engineering",
    question: "Why does the invite flow keep breaking?",
    answer: "Three of the last five reports trace to the same cause: the invite token TTL.",
    bullets: [
      "Tokens expire after one hour, but the invite email is queued behind the digest job.",
      "It was raised in #bugs in June and closed as not-reproducible.",
    ],
    closing: "Two open pull requests touch this file. Neither changes the TTL.",
  },
  {
    role: "Go-to-market",
    question: "Which trials went quiet after week one?",
    answer: "Six of the nineteen trials started last month never ran a second session.",
    bullets: [
      "Five of the six never connected a source, so their wiki stayed empty.",
      "The one that did connect a source stalled on a GitHub permission error.",
    ],
    closing: "Onboarding is the pattern here, not the product. Drafts are ready for all six.",
  },
  {
    role: "Support",
    question: "Has anyone reported this before?",
    answer: "Yes — twice, and both were the same underlying issue.",
    bullets: [
      "BUG-388 in July, closed after a workaround was shared in-thread.",
      "A Slack report in September that was never filed as an issue.",
    ],
    closing: "The workaround from BUG-388 still applies. Reply drafted with the exact steps.",
  },
];

const CALLOUTS = [
  {
    title: "Ask across everything",
    body: "One question reaches the wiki, the threads, the code, and the tickets at once.",
  },
  {
    title: "Trace the decision",
    body: "Follow any answer back to the specific messages and commits it came from.",
  },
  {
    title: "Size the problem",
    body: "See how many customers a problem actually touches before you decide to fix it.",
  },
];

/**
 * Teams section. The role list on the left swaps the chat answer on the right —
 * the one interactive element on the page, because the claim is that the same
 * question surface serves every function, and a static screenshot can't show that.
 *
 * Modelled as a group of toggle buttons rather than an ARIA tablist. A tablist
 * owes the reader `aria-controls`, a `tabpanel`, and arrow-key navigation, and
 * it would be announcing a widget that is really a single swapping illustration.
 * `aria-pressed` describes what actually happens, and the panel it swaps is
 * readable (`decorative={false}`) and `aria-live`, so the change is perceivable
 * rather than silent.
 */
export function V2Teams() {
  const [activeRole, setActiveRole] = useState(TEAMS[0].role);
  const active = TEAMS.find((team) => team.role === activeRole) ?? TEAMS[0];

  return (
    <Section title="Run the whole company from one workspace" eyebrow="Teams" index="4.0">
      <div className={GRID}>
        <div
          aria-label="Choose a team"
          role="group"
          className="col-span-12 flex flex-col items-start border-border border-l sm:col-span-4"
        >
          {TEAMS.map((team) => (
            <button
              key={team.role}
              type="button"
              aria-pressed={team.role === activeRole}
              onClick={() => setActiveRole(team.role)}
              className={cn(
                "-ml-px border-transparent border-l py-1.5 pl-6 text-left text-[24px] leading-[1.3] tracking-[-0.02em] transition-colors",
                team.role === activeRole
                  ? "border-foreground/60 text-foreground"
                  : "text-foreground/35 hover:text-foreground/60",
              )}
            >
              {team.role}
            </button>
          ))}
        </div>

        <Panel
          className="col-span-12 mt-8 sm:col-span-8 sm:col-start-5 sm:mt-0"
          height="h-[480px] sm:h-[520px]"
          decorative={false}
          aria-live="polite"
        >
          <ChatMockup
            question={active.question}
            answer={active.answer}
            bullets={active.bullets}
            closing={active.closing}
          />
        </Panel>

        <div className="col-span-12 mt-12 grid gap-8 sm:col-span-8 sm:col-start-5 sm:mt-8 sm:grid-cols-3">
          {CALLOUTS.map(({ title, body }) => (
            <div key={title} className="border-border border-l pl-4">
              <h3 className="text-[13px] text-foreground leading-[1.5]">{title}</h3>
              <p className={cn(BODY, "mt-1.5 text-[13px] text-foreground/50")}>{body}</p>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
