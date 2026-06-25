"use client";

import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { Check, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { ModelRatingMeters, modelRatingsTitle } from "@/components/agent-editor/ModelRatingMeters";
import {
  AGENT_MODELS,
  type AgentModel,
  findModel,
  modelProviderId,
  modelProviderLabel,
} from "@/components/agent-editor/tools";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/lib/useIsMobile";
import { cn } from "@/lib/utils";

// Group models by provider (in catalog order) for the searchable picker. Shared across
// every model picker (agent editor, root composer, session composer) so grouping stays
// consistent in one place.
function useModelsByProvider(modelIds?: readonly AgentModelId[]) {
  return useMemo(() => {
    const allowedModelIds = modelIds ? new Set<string>(modelIds) : null;
    const order: string[] = [];
    const byProvider = new Map<string, AgentModel[]>();
    for (const model of AGENT_MODELS) {
      if (allowedModelIds && !allowedModelIds.has(model.id)) continue;
      const provider = modelProviderId(model.id);
      const bucket = byProvider.get(provider);
      if (bucket) {
        bucket.push(model);
      } else {
        byProvider.set(provider, [model]);
        order.push(provider);
      }
    }
    return order.map((provider) => ({
      provider,
      label: modelProviderLabel(provider),
      models: byProvider.get(provider) ?? [],
    }));
  }, [modelIds]);
}

type ModelPickerProps = {
  value: string;
  onChange: (modelId: AgentModelId) => void;
  /** Fallback model id when `value` is not a known catalog model. */
  fallbackModelId: AgentModelId;
  disabled?: boolean;
  align?: "start" | "center" | "end";
  /** Extra classes for the trigger button so call sites can size it to their chrome. */
  triggerClassName?: string;
  /** Restrict selectable models to this subset, preserving catalog order and provider grouping. */
  modelIds?: readonly AgentModelId[];
  "aria-label"?: string;
};

// Searchable, provider-grouped model picker with rating meters. Self-contained: it resolves
// the selected model from `value`, renders the trigger (icon + label + chevron) and the
// command popover, and calls `onChange` with the chosen model id. It does not persist
// anything itself — the caller decides what selecting a model means.
export function ModelPicker({
  value,
  onChange,
  fallbackModelId,
  disabled,
  align = "start",
  triggerClassName,
  modelIds,
  "aria-label": ariaLabel = "Model",
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  // On mobile, tapping a text input opens the on-screen keyboard. Most people pick a model by
  // scanning the list, not typing, so we drop the search box on phones and stop the popover from
  // auto-focusing anything — the list is just scrolled and tapped (desktop keeps instant search).
  const isMobile = useIsMobile();
  const modelsByProvider = useModelsByProvider(modelIds);
  const modelIdSet = useMemo(() => (modelIds ? new Set<string>(modelIds) : null), [modelIds]);
  const selectedModel =
    (modelIdSet && !modelIdSet.has(value) ? null : findModel(value)) ?? findModel(fallbackModelId)!;
  const SelectedModelIcon = selectedModel.icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(
            "flex h-6 w-auto items-center gap-1.5 rounded-md px-1.5 text-[11.5px] font-medium text-ink-muted outline-none transition-colors hover:bg-surface-subtle/70 focus-visible:bg-surface-subtle/70 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-surface-subtle/70",
            triggerClassName,
          )}
        >
          <SelectedModelIcon size={12} strokeWidth={1.9} className="shrink-0" />
          <span className="truncate">{selectedModel.label}</span>
          <ChevronDown size={12} strokeWidth={1.9} className="ml-0.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-[360px] max-w-[calc(100vw-1.5rem)] p-0"
        onOpenAutoFocus={(event) => {
          if (isMobile) event.preventDefault();
        }}
      >
        <Command>
          {!isMobile ? <CommandInput placeholder="Search models or providers…" /> : null}
          <div className="flex items-center justify-end px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-ink-subtle">
            Capability · Speed · Cost
          </div>
          <CommandList>
            <CommandEmpty>No models found.</CommandEmpty>
            {modelsByProvider.map((group) => (
              <CommandGroup key={group.provider} heading={group.label}>
                {group.models.map((model) => {
                  const ModelIcon = model.icon;
                  const isSelected = model.id === selectedModel.id;
                  return (
                    <CommandItem
                      key={model.id}
                      value={model.id}
                      keywords={[model.label, group.label]}
                      onSelect={() => {
                        onChange(model.id);
                        setOpen(false);
                      }}
                      title={
                        model.ratings
                          ? modelRatingsTitle(model.label, model.description, model.ratings)
                          : model.description
                      }
                      className="gap-2 py-1.5"
                    >
                      <Check
                        size={13}
                        strokeWidth={2}
                        className={cn(
                          "shrink-0 text-ink",
                          isSelected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <ModelIcon size={13} strokeWidth={1.85} className="shrink-0 text-ink-muted" />
                      <span className="min-w-0 flex-1 truncate">{model.label}</span>
                      {model.ratings ? (
                        <ModelRatingMeters
                          ratings={model.ratings}
                          className="shrink-0 text-ink-muted"
                        />
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
