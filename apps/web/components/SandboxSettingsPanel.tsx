"use client";

import type { SandboxSize } from "@opencompany/core/sandbox-sizes";
import { toast } from "@opencompany/ui/components/sonner";
import { useState, useTransition } from "react";
import { setWorkspaceSandboxSizeAction, type WorkspaceSandboxSizeResult } from "@/lib/sandbox-size";
import { formatUsdMicros } from "@/lib/usage-spend";

// One selectable machine size, with the hourly price computed from the same billing
// rates the sandbox meter charges (resolved on the server, where the rate table lives).
export type SandboxSizeOptionView = {
  size: SandboxSize;
  label: string;
  summary: string;
  cpuCount: number;
  memoryMB: number;
  hourlyCostUsdMicros: number;
};

export function SandboxSettingsPanel({
  canManage,
  sandboxSize,
  sandboxSizeOptions,
}: {
  canManage: boolean;
  sandboxSize: WorkspaceSandboxSizeResult;
  sandboxSizeOptions: SandboxSizeOptionView[];
}) {
  return (
    <section aria-labelledby="sandbox-size-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="sandbox-size-heading" className="text-[15px] font-semibold text-ink">
          Sandbox size
        </h2>
        <p className="text-[13px] leading-5 text-ink-subtle">
          Every new session starts on this size. Sandbox time is billed per second on the vCPU and
          memory it holds, so a smaller size costs less per hour.
        </p>
      </div>
      <SandboxSizeCard
        sandboxSize={sandboxSize}
        options={sandboxSizeOptions}
        canManage={canManage}
      />
    </section>
  );
}

function SandboxSizeCard({
  sandboxSize,
  options,
  canManage,
}: {
  sandboxSize: WorkspaceSandboxSizeResult;
  options: SandboxSizeOptionView[];
  canManage: boolean;
}) {
  const [selected, setSelected] = useState<SandboxSize | null>(
    sandboxSize.ok ? sandboxSize.sandboxSize : null,
  );
  const [isPending, startTransition] = useTransition();

  if (!sandboxSize.ok) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <p className="text-[13px] leading-5 text-warning">{sandboxSize.error}</p>
      </div>
    );
  }

  const select = (next: SandboxSize) => {
    if (selected === next || isPending) return;
    const previous = selected;
    setSelected(next);
    startTransition(async () => {
      const result = await setWorkspaceSandboxSizeAction(next);
      if (result.ok) {
        setSelected(result.sandboxSize);
        toast.success(
          `New sessions will run on ${labelForSize(options, result.sandboxSize)}. Sessions already running keep their size.`,
        );
        return;
      }
      setSelected(previous);
      toast.error(result.error);
    });
  };

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex flex-col gap-2">
        {options.map((option) => (
          <label
            key={option.size}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-ink/10 p-3 has-[:disabled]:cursor-default"
          >
            <input
              type="radio"
              name="opencompany-workspace-sandbox-size"
              checked={selected === option.size}
              disabled={!canManage || isPending}
              onChange={() => select(option.size)}
              className="mt-0.5 accent-ink"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-medium text-ink">
                {option.label} · {option.cpuCount} vCPU · {option.memoryMB / 1024} GB
              </span>
              <span className="text-[12px] leading-5 text-ink-subtle">
                {option.summary} About {formatUsdMicros(option.hourlyCostUsdMicros)} per hour of
                running time.
              </span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-[12px] leading-4 text-ink-subtle">
        {canManage
          ? "Sessions that are already running keep the size they started with."
          : "Managed by workspace admins."}
      </p>
    </div>
  );
}

function labelForSize(options: SandboxSizeOptionView[], size: SandboxSize) {
  return options.find((option) => option.size === size)?.label ?? size;
}
