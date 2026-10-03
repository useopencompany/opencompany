"use client";
import type { WorkflowEventFilterValue } from "@opencompany/core";
import { Button } from "@opencompany/ui/components/button";
import { Input } from "@opencompany/ui/components/input";
export function ExactTagConditions({
  value,
  disabled,
  onChange,
}: {
  value: WorkflowEventFilterValue | null;
  disabled?: boolean;
  onChange: (value: WorkflowEventFilterValue | null) => void;
}) {
  const pairs = value?.pairs ?? [];
  const update = (next: typeof pairs) =>
    onChange(next.length ? { id: "exact-tags", name: "Exact tags", pairs: next } : null);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-ink-subtle">
        All exact tag pairs must match on the same occurrence.
      </span>
      {pairs.map((pair, index) => (
        <div key={index} className="flex gap-2">
          <Input
            aria-label={`Tag key ${index + 1}`}
            value={pair.key}
            disabled={disabled}
            maxLength={64}
            placeholder="Tag key"
            onChange={(event) =>
              update(
                pairs.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)),
              )
            }
          />
          <Input
            aria-label={`Tag value ${index + 1}`}
            value={pair.value}
            disabled={disabled}
            maxLength={256}
            placeholder="Exact value"
            onChange={(event) =>
              update(
                pairs.map((item, i) =>
                  i === index ? { ...item, value: event.target.value } : item,
                ),
              )
            }
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`Remove tag ${index + 1}`}
            onClick={() => update(pairs.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        className="self-start"
        variant="outline"
        size="sm"
        disabled={disabled || pairs.length >= 16}
        onClick={() => update([...pairs, { key: "", value: "" }])}
      >
        Add exact tag
      </Button>
    </div>
  );
}
