import { cn } from "@opencompany/ui/lib/utils";
import { DISPLAY, GRID, microMono, SECTION, SHELL } from "./tokens";

/**
 * 10px uppercase mono label. Used for section eyebrows, the numbering in the
 * right margin, and the kicker above each platform pillar — never for anything
 * the reader has to actually read.
 */
export function Micro({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        microMono.className,
        "text-[10px] text-foreground/50 uppercase leading-[10px] tracking-[0.1em]",
        className,
      )}
    >
      {children}
    </p>
  );
}

/**
 * Section opener: hairline rule, heading on the left, and a mono eyebrow plus
 * section number sitting out in the right two-thirds of the grid. The `mt-2`
 * on the labels optically centers 10px type against the heading's cap height.
 */
export function SectionHeader({
  title,
  eyebrow,
  index,
}: {
  title: string;
  /** Omitted by the closing section, which drops the numbering entirely. */
  eyebrow?: string | undefined;
  index?: string | undefined;
}) {
  return (
    <div className={GRID}>
      <h2 className={cn(DISPLAY, "col-span-12 sm:col-span-7")}>{title}</h2>
      {eyebrow ? (
        <Micro className="col-span-6 mt-4 sm:col-span-2 sm:col-start-9 sm:mt-2">{eyebrow}</Micro>
      ) : null}
      {index ? (
        // Decoration: reading "one point zero" between the heading and its
        // content tells a screen reader user nothing.
        <Micro
          aria-hidden="true"
          className="col-span-6 mt-4 text-right sm:col-span-2 sm:col-start-11 sm:mt-2"
        >
          {index}
        </Micro>
      ) : null}
    </div>
  );
}

/** A full section: hairline, header, and the caller's content 96px below it. */
export function Section({
  title,
  eyebrow,
  index,
  children,
  className,
}: {
  title: string;
  eyebrow?: string | undefined;
  index?: string | undefined;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(SECTION, className)}>
      <div className={SHELL}>
        <SectionHeader title={title} eyebrow={eyebrow} index={index} />
        <div className="mt-16 sm:mt-24">{children}</div>
      </div>
    </section>
  );
}

/** Right-pointing arrow used in the nav pill and the get-started cards. */
export function Arrow({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-3.5", className)}
    >
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}
