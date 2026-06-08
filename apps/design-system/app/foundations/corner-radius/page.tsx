import { PageHeader } from "@/components/docs-primitives";

type RadiusRow = { name: string; className: string; token: string };

const RADII: RadiusRow[] = [
  { name: "Small", className: "rounded-sm", token: "--radius-sm (calc(--radius - 4px))" },
  { name: "Medium", className: "rounded-md", token: "--radius-md (calc(--radius - 2px))" },
  { name: "Large", className: "rounded-lg", token: "--radius-lg (--radius)" },
  { name: "Extra large", className: "rounded-xl", token: "--radius-xl (calc(--radius + 4px))" },
  { name: "Full", className: "rounded-full", token: "9999px" },
];

export default function CornerRadiusPage() {
  return (
    <article>
      <PageHeader
        title="Corner Radius"
        description="Radii derive from a single --radius token (0.5rem). Components use the small–large steps; pills and avatars use full."
      />
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
        {RADII.map((r) => (
          <div key={r.name} className="flex flex-col items-center gap-3 text-center">
            <div className={`size-20 border border-border bg-muted ${r.className}`} />
            <div>
              <p className="text-sm font-medium">{r.name}</p>
              <code className="text-[11px] text-muted-foreground">{r.token}</code>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
