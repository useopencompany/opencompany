import { cn } from "@opencompany/ui/lib/utils";
import { Micro, Section } from "./primitives";
import { BODY, GRID } from "./tokens";

const PILLARS = [
  {
    kicker: "Full context",
    title: "A wiki that writes itself",
    body: "Connect Slack, GitHub, Linear, and Gmail in a few clicks. opencompany compiles them into a living company wiki and keeps it current as the work happens.",
  },
  {
    kicker: "System of record",
    title: "One context every agent reads",
    body: "Decisions, projects, and people live in structured pages an agent can retrieve — so the answer is the same whoever, or whatever, asks the question.",
  },
  {
    kicker: "Any model, any harness",
    title: "Bring the agents you pay for",
    body: "Run sessions on Claude Code, Codex, or any model. opencompany drives the subscriptions you already have instead of reselling agent usage back to you.",
  },
  {
    kicker: "Cloud sandboxes",
    title: "Work that runs without you",
    body: "Tasks and workflows execute in isolated cloud sandboxes with no local setup. Start one from your phone and come back to a pull request.",
  },
];

/** One plane of the exploded stack: hairline edge, faint grid fill, corner nodes. */
function Plane({ depth, children }: { depth: number; children?: React.ReactNode }) {
  return (
    <div
      className="absolute inset-0 rounded-[2px] border border-foreground/20 [background-image:linear-gradient(to_right,rgba(0,0,0,0.07)_1px,transparent_1px),linear-gradient(to_bottom,rgba(0,0,0,0.07)_1px,transparent_1px)] [background-size:20px_20px]"
      style={{ transform: `translateZ(${depth}px)` }}
    >
      {[
        "-top-[3px] -left-[3px]",
        "-top-[3px] -right-[3px]",
        "-bottom-[3px] -left-[3px]",
        "-bottom-[3px] -right-[3px]",
      ].map((corner) => (
        <span
          key={corner}
          className={cn("absolute size-[5px] rounded-full bg-foreground/25", corner)}
        />
      ))}
      {children}
    </div>
  );
}

/** Small extruded block, used to suggest records sitting on a plane. */
function Block({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "absolute h-4 w-7 rounded-[2px] border border-foreground/20 bg-white/70",
        className,
      )}
    />
  );
}

/**
 * Exploded isometric stack: sources at the bottom, the compiled wiki in the
 * middle, agents on top. Built with CSS 3D rather than a flat illustration so it
 * stays crisp at any zoom and carries no image weight.
 */
function StackDiagram() {
  return (
    /*
     * `perspective` has to sit on the parent — set on the transformed element
     * itself it applies to that element's children instead, which flattens the
     * stack into an orthographic projection.
     */
    <div
      aria-hidden="true"
      className="relative h-[300px] overflow-hidden [perspective:1400px] sm:h-[520px]"
    >
      <div
        className="absolute top-1/2 left-1/2 size-[220px] [transform-style:preserve-3d] sm:size-[340px]"
        style={{ transform: "translate(-50%, -50%) rotateX(58deg) rotateZ(-45deg)" }}
      >
        <Plane depth={145}>
          <span className="absolute top-[28%] left-[22%] size-1.5 rounded-full bg-foreground/40" />
          <span className="absolute top-[56%] left-[62%] size-1.5 rounded-full bg-foreground/40" />
          <span className="absolute top-[74%] left-[34%] size-1.5 rounded-full bg-foreground/40" />
        </Plane>
        <Plane depth={0}>
          <Block className="top-[30%] left-[26%]" />
          <Block className="top-[48%] left-[54%]" />
          <Block className="top-[66%] left-[32%]" />
          <Block className="top-[24%] left-[60%]" />
        </Plane>
        <Plane depth={-145} />
      </div>
    </div>
  );
}

/**
 * Platform section: diagram in the left half, the four pillars stacked in a
 * 360px column starting at column 8.
 */
export function V2Platform() {
  return (
    <Section title="How opencompany works" eyebrow="Platform" index="2.0">
      <div className={GRID}>
        <div className="col-span-12 sm:col-span-6">
          <StackDiagram />
        </div>
        <div className="col-span-12 space-y-10 sm:col-span-5 sm:col-start-8">
          {PILLARS.map(({ kicker, title, body }) => (
            <div key={kicker} className="max-w-[360px]">
              <Micro>{kicker}</Micro>
              <h3 className={cn(BODY, "mt-3 text-foreground")}>{title}</h3>
              <p className={cn(BODY, "mt-1.5 text-foreground/50")}>{body}</p>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
