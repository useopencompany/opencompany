import type { ModelRatings, ModelRatingTier } from "@opencompany/agent-runtime";
import { cn } from "@/lib/utils";

export const CAPABILITY_LABELS: Record<ModelRatingTier, string> = {
  1: "Basic",
  2: "Capable",
  3: "Frontier",
};

export const SPEED_LABELS: Record<ModelRatingTier, string> = {
  1: "Slow",
  2: "Medium",
  3: "Fast",
};

export const COST_LABELS: Record<ModelRatingTier, string> = {
  1: "$",
  2: "$$",
  3: "$$$",
};

/**
 * Plain-language readout for a model's ratings, used as the row's hover title.
 * Native `title` is intentional: a styled Radix Tooltip fights Radix Select's
 * focus/pointer management, so the cheap, reliable browser tooltip wins here.
 */
export function modelRatingsTitle(label: string, description: string, ratings: ModelRatings) {
  return [
    label,
    description,
    `Capability: ${CAPABILITY_LABELS[ratings.capability]} · Speed: ${SPEED_LABELS[ratings.speed]} · Cost: ${COST_LABELS[ratings.cost]}`,
  ].join("\n");
}

const TIERS: ModelRatingTier[] = [1, 2, 3];

function DotMeter({ value, label }: { value: ModelRatingTier; label: string }) {
  return (
    <span
      className="inline-flex w-7 items-center justify-center gap-[3px]"
      role="img"
      aria-label={label}
    >
      {TIERS.map((tier) => (
        <span
          key={tier}
          className={cn(
            "h-[4px] w-[4px] rounded-full",
            tier <= value ? "bg-ink-muted" : "bg-ink-subtle/25",
          )}
        />
      ))}
    </span>
  );
}

function CostMeter({ value, label }: { value: ModelRatingTier; label: string }) {
  return (
    <span
      className="inline-flex w-7 items-center justify-center font-medium tabular-nums"
      role="img"
      aria-label={label}
    >
      {TIERS.map((tier) => (
        <span key={tier} className={tier <= value ? "text-ink-muted" : "text-ink-subtle/25"}>
          $
        </span>
      ))}
    </span>
  );
}

/**
 * Compact, right-aligned Capability · Speed · Cost cluster shown per model row.
 * Capability and Speed read as filled dots (more = better); Cost as `$` glyphs
 * (more = pricier) so the "good direction" is unambiguous per dimension. Every
 * cluster is fixed-width, so rows stay uniform.
 */
export function ModelRatingMeters({
  ratings,
  className,
}: {
  ratings: ModelRatings;
  className?: string;
}) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-[10px] leading-none", className)}>
      <DotMeter
        value={ratings.capability}
        label={`Capability: ${CAPABILITY_LABELS[ratings.capability]}`}
      />
      <DotMeter value={ratings.speed} label={`Speed: ${SPEED_LABELS[ratings.speed]}`} />
      <CostMeter value={ratings.cost} label={`Cost: ${COST_LABELS[ratings.cost]}`} />
    </span>
  );
}
