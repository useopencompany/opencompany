import { cn } from "@opencompany/ui/lib/utils";
import { PageHeader, SectionTitle } from "@/components/docs-primitives";

type Swatch = { name: string; className: string; border?: boolean };

const CORE: Swatch[] = [
  { name: "background", className: "bg-background", border: true },
  { name: "foreground", className: "bg-foreground" },
  { name: "card", className: "bg-card", border: true },
  { name: "popover", className: "bg-popover", border: true },
  { name: "primary", className: "bg-primary" },
  { name: "primary-foreground", className: "bg-primary-foreground", border: true },
  { name: "secondary", className: "bg-secondary" },
  { name: "muted", className: "bg-muted", border: true },
  { name: "muted-foreground", className: "bg-muted-foreground" },
  { name: "accent", className: "bg-accent" },
  { name: "destructive", className: "bg-destructive" },
  { name: "border", className: "bg-border" },
  { name: "input", className: "bg-input" },
  { name: "ring", className: "bg-ring" },
];

const SEMANTIC: Swatch[] = [
  { name: "success", className: "bg-success" },
  { name: "success-bg", className: "bg-success-bg", border: true },
  { name: "warning", className: "bg-warning" },
  { name: "warning-bg", className: "bg-warning-bg", border: true },
  { name: "info", className: "bg-info" },
  { name: "info-bg", className: "bg-info-bg", border: true },
  { name: "brand", className: "bg-brand" },
  { name: "brand-bg", className: "bg-brand-bg", border: true },
  { name: "sidebar", className: "bg-sidebar", border: true },
  { name: "surface-raised", className: "bg-surface-raised", border: true },
  { name: "surface-active", className: "bg-surface-active" },
  { name: "surface-selected", className: "bg-surface-selected" },
];

function SwatchGrid({ swatches }: { swatches: Swatch[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
      {swatches.map((s) => (
        <div key={s.name} className="flex flex-col gap-2">
          <div
            className={cn(
              "h-16 w-full rounded-md",
              s.className,
              s.border && "border border-border",
            )}
          />
          <code className="text-xs text-muted-foreground">{s.name}</code>
        </div>
      ))}
    </div>
  );
}

export default function ColorsPage() {
  return (
    <article>
      <PageHeader
        title="Colors"
        description="Tokens follow shadcn naming with OpenCompany values. They adapt automatically to light and dark — toggle the theme to preview. Use them via Tailwind utilities like bg-primary or text-muted-foreground."
      />
      <SectionTitle>Core</SectionTitle>
      <SwatchGrid swatches={CORE} />
      <SectionTitle>Brand &amp; status</SectionTitle>
      <SwatchGrid swatches={SEMANTIC} />
    </article>
  );
}
