import { cn } from "@opencompany/ui/lib/utils";

type CtaProps = {
  href?: string;
  variant?: "primary" | "secondary";
  className?: string;
  children: React.ReactNode;
};

// Squared, monospace call-to-action — primary is a solid ink block, secondary is
// a muted mono link (see the reference: "Book an onboarding call · Join Waitlist").
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
        "inline-flex items-center rounded-none font-medium font-mono tracking-tight transition",
        variant === "primary"
          ? "bg-black px-4 py-2.5 text-[13px] text-white hover:bg-black/85"
          : "px-2 py-2.5 text-[13px] text-ink-subtle hover:text-ink",
        className,
      )}
    >
      {children}
    </a>
  );
}
