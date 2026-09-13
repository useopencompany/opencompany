import {
  AnthropicIcon,
  GeminiIcon,
  GitHubIcon,
  GmailIcon,
  GoogleDriveIcon,
  LinearIcon,
  type LucideIcon,
  NotionIcon,
  OpenAIIcon,
  SlackIcon,
  StripeIcon,
} from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import { Micro } from "./primitives";
import { LEAD, SHELL } from "./tokens";

const WORKS_WITH: { label: string; Icon: LucideIcon }[] = [
  { label: "Claude Code", Icon: AnthropicIcon },
  { label: "Codex", Icon: OpenAIIcon },
  { label: "Gemini", Icon: GeminiIcon },
  { label: "Slack", Icon: SlackIcon },
  { label: "GitHub", Icon: GitHubIcon },
  { label: "Linear", Icon: LinearIcon },
  { label: "Gmail", Icon: GmailIcon },
  { label: "Notion", Icon: NotionIcon },
  { label: "Google Drive", Icon: GoogleDriveIcon },
  { label: "Stripe", Icon: StripeIcon },
];

/**
 * Full-bleed logo marquee. The list is rendered twice so the translation can
 * loop seamlessly at -50%; the duplicate is hidden from assistive tech.
 */
export function WorksWith() {
  return (
    <section className="pt-24 sm:pt-32">
      <Micro className="text-center">Works with</Micro>
      <div className="relative mt-10 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
        <div className="flex w-max animate-marquee-x items-center gap-16 pr-16">
          {[0, 1].map((copy) => (
            <div
              key={copy}
              aria-hidden={copy === 1 || undefined}
              className="flex shrink-0 items-center gap-16"
            >
              {WORKS_WITH.map(({ label, Icon }) => (
                <span
                  key={label}
                  className="flex shrink-0 items-center gap-2 text-[15px] text-foreground/45"
                >
                  <Icon className="size-4" />
                  {label}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const MANIFESTO = [
  "For agents to do real work, they have to understand how your company actually operates. Generic chat tools don't. Every session starts from nothing, so you re-explain the same context and get generic output back.",
  "opencompany builds that understanding for you. It compiles a living wiki from Slack, GitHub, Linear, and Gmail, and keeps it current as the work happens.",
  "Agents work from it. They run sessions in cloud sandboxes, take repeatable processes over as workflows, and open pull requests you review — on the Claude and Codex subscriptions you already pay for.",
  "And your whole team works from the same context, whether they are in the workspace or not.",
];

/**
 * The argument, set as a 540px column centered in the shell. No heading and no
 * visual: the reference design uses one plain-prose section to carry the thesis,
 * with only a tonal step between the opening claim and the reasoning under it.
 */
export function Manifesto() {
  return (
    <section className="pt-32 pb-24 sm:pt-36 sm:pb-40">
      <div className={SHELL}>
        <div className="mx-auto max-w-[540px] space-y-6">
          <p className={cn(LEAD, "text-balance text-foreground")}>
            The companies of the future will run on a shared model of how they work, not a folder of
            documents nobody opens.
          </p>
          {MANIFESTO.map((paragraph) => (
            <p key={paragraph} className={cn(LEAD, "text-foreground/65")}>
              {paragraph}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
