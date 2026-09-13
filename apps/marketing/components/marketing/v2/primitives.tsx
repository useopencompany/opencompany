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
  eyebrow: string;
  index: string;
}) {
  return (
    <div className={GRID}>
      <h2 className={cn(DISPLAY, "col-span-12 sm:col-span-7")}>{title}</h2>
      <Micro className="col-span-6 mt-4 sm:col-span-2 sm:col-start-9 sm:mt-2">{eyebrow}</Micro>
      <Micro className="col-span-6 mt-4 text-right sm:col-span-2 sm:col-start-11 sm:mt-2">
        {index}
      </Micro>
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
  eyebrow: string;
  index: string;
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

/**
 * Buttons in this design are deliberately small — 32px tall, 10px of horizontal
 * padding, 12px type — so they read as controls rather than billboards.
 */
export function Button({
  href,
  variant = "primary",
  className,
  children,
}: {
  href: string;
  variant?: "primary" | "secondary" | "onDark";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-[6px] px-2.5 text-[12px] leading-[1.45] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        variant === "primary" && "bg-[#0a0a0a] text-white hover:bg-[#0a0a0a]/90",
        variant === "secondary" &&
          "bg-foreground/[0.04] text-foreground hover:bg-foreground/[0.08]",
        variant === "onDark" && "bg-white/90 text-[#0a0a0a] hover:bg-white",
        className,
      )}
    >
      {children}
    </a>
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
