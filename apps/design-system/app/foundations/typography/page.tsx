import { PageHeader } from "@/components/docs-primitives";

type TypeRow = {
  name: string;
  className: string;
  meta: string;
};

const SCALE: TypeRow[] = [
  { name: "Display", className: "text-4xl font-semibold tracking-tight", meta: "36px / 600" },
  { name: "Heading 1", className: "text-3xl font-semibold tracking-tight", meta: "30px / 600" },
  { name: "Heading 2", className: "text-2xl font-semibold tracking-tight", meta: "24px / 600" },
  { name: "Heading 3", className: "text-xl font-semibold", meta: "20px / 600" },
  { name: "Body Large", className: "text-base", meta: "16px / 400" },
  { name: "Body", className: "text-sm", meta: "14px / 400" },
  { name: "Label", className: "text-sm font-medium", meta: "14px / 500" },
  { name: "Caption", className: "text-xs text-muted-foreground", meta: "12px / 400" },
];

export default function TypographyPage() {
  return (
    <article>
      <PageHeader
        title="Typography"
        description="The system uses a single sans-serif family with Inter OpenType features enabled. The scale below covers display headings down to captions."
      />
      <div className="flex flex-col divide-y divide-border">
        {SCALE.map((row) => (
          <div key={row.name} className="flex items-baseline justify-between gap-6 py-5">
            <span className={row.className}>{row.name}</span>
            <code className="shrink-0 text-xs text-muted-foreground">{row.meta}</code>
          </div>
        ))}
      </div>
    </article>
  );
}
