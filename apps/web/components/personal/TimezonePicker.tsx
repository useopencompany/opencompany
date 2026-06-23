"use client";

import { Check, ChevronDown, Globe2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  browserTimezone,
  COMMON_TIMEZONES,
  supportedTimezones,
  timezoneLabel,
  timezoneSearchLabel,
  type UserTimezoneSource,
} from "@/lib/timezones";
import { cn } from "@/lib/utils";

type TimezonePickerProps = {
  value: string;
  source: UserTimezoneSource;
  disabled?: boolean;
  onChange: (timezone: string, source: Exclude<UserTimezoneSource, "unset">) => void;
};

export function TimezonePicker({ value, source, disabled, onChange }: TimezonePickerProps) {
  const [open, setOpen] = useState(false);
  const detectedTimezone = browserTimezone();
  const timezoneOptions = useMemo(() => supportedTimezones(), []);
  const common = useMemo(
    () => timezoneOptions.filter((timezone) => COMMON_TIMEZONES.includes(timezone as never)),
    [timezoneOptions],
  );
  const allOther = useMemo(
    () => timezoneOptions.filter((timezone) => !COMMON_TIMEZONES.includes(timezone as never)),
    [timezoneOptions],
  );

  function selectTimezone(timezone: string, nextSource: Exclude<UserTimezoneSource, "unset">) {
    onChange(timezone, nextSource);
    setOpen(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Timezone"
            className="flex h-8 w-full max-w-[340px] items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-ink outline-none transition-colors duration-150 hover:bg-surface-muted focus:ring-1 focus:ring-ink/15 disabled:cursor-not-allowed disabled:opacity-55"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Globe2 size={13} strokeWidth={1.9} className="shrink-0 text-ink-muted" />
              <span className="truncate">{timezoneLabel(value)}</span>
            </span>
            <ChevronDown size={13} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[380px] max-w-[calc(100vw-1.5rem)] p-0">
          <Command>
            <CommandInput placeholder="Search timezones..." />
            <CommandList>
              <CommandEmpty>No timezone found.</CommandEmpty>
              {detectedTimezone ? (
                <CommandGroup heading="Detected">
                  <TimezoneItem
                    timezone={detectedTimezone}
                    selected={value === detectedTimezone && source === "browser"}
                    label={`Use browser timezone: ${timezoneLabel(detectedTimezone)}`}
                    onSelect={() => selectTimezone(detectedTimezone, "browser")}
                  />
                </CommandGroup>
              ) : null}
              <CommandGroup heading="Common">
                {common.map((timezone) => (
                  <TimezoneItem
                    key={timezone}
                    timezone={timezone}
                    selected={value === timezone && source !== "browser"}
                    onSelect={() => selectTimezone(timezone, "manual")}
                  />
                ))}
              </CommandGroup>
              <CommandGroup heading="All timezones">
                {allOther.map((timezone) => (
                  <TimezoneItem
                    key={timezone}
                    timezone={timezone}
                    selected={value === timezone && source !== "browser"}
                    onSelect={() => selectTimezone(timezone, "manual")}
                  />
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <p className="text-[12px] leading-5 text-ink-muted">
        {source === "manual"
          ? "Manual timezone. Personal routines use this even if your browser changes."
          : "Detected timezone. Personal routines follow this browser's timezone."}
      </p>
    </div>
  );
}

function TimezoneItem({
  timezone,
  selected,
  label,
  onSelect,
}: {
  timezone: string;
  selected: boolean;
  label?: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={timezone}
      keywords={[timezoneSearchLabel(timezone), timezoneLabel(timezone)]}
      onSelect={onSelect}
      className="gap-2"
    >
      <Check
        size={13}
        strokeWidth={2}
        className={cn("shrink-0 text-ink", selected ? "opacity-100" : "opacity-0")}
      />
      <span className="min-w-0 flex-1 truncate">{label ?? timezoneLabel(timezone)}</span>
    </CommandItem>
  );
}
