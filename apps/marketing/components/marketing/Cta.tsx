import { cn } from "@opencompany/ui/lib/utils";

type CtaProps = {
  href?: string;
  variant?: "primary" | "secondary";
  className?: string;
  children: React.ReactNode;
};

// Call-to-action built on the shadcn button base, tweaked toward a softer,
// rounded near-black block: primary is a solid ink button (white text), secondary
// is a subtle bordered button that pairs beside it.
export function Cta({
  href = "https://cal.com/louis-morgner-k0wc9i/opencompany-onboarding",
  variant = "primary",
  className,
  children,
}: CtaProps) {
  return (
    <a
      href={href}
      data-visitors-event={variant === "primary" ? "signup" : undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] px-6 py-2.5 font-medium font-sans text-[15px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        variant === "primary"
          ? "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
          : "border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
        className,
      )}
    >
      {children}
    </a>
  );
}
