"use client";

import type { GoatWorkspaceCapabilityState } from "@opencompany/db/goat-capabilities";
import type { GoatManagedCapabilitySource } from "@opencompany/db/goat-schema";
import { Switch } from "@opencompany/ui/components/switch";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { GoatSettingsContent } from "@/components/GoatSettingsChrome";
import { setWorkspaceCapabilityAction } from "@/lib/capabilities/actions";

const CAPABILITY_COPY: Record<GoatManagedCapabilitySource, { label: string; description: string }> =
  {
    x: {
      label: "X",
      description: "Search public posts, profiles, threads, and replies.",
    },
    linkedin: {
      label: "LinkedIn",
      description: "Research public people, companies, posts, and comments.",
    },
    youtube: {
      label: "YouTube",
      description: "Search public videos, Shorts, channels, transcripts, and comments.",
    },
    instagram: {
      label: "Instagram",
      description: "Research public profiles, posts, Reels, hashtags, and comments.",
    },
    tiktok: {
      label: "TikTok",
      description: "Search public creators, videos, comments, hashtags, and trends.",
    },
    lead: {
      label: "Lead enrichment",
      description: "Find and enrich professional profiles and contact details.",
    },
  };

export function GoatCapabilitiesPanel({
  capabilities,
  isAdmin,
}: {
  capabilities: GoatWorkspaceCapabilityState[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(capabilities);
  const [pendingSource, setPendingSource] = useState<GoatManagedCapabilitySource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const setEnabled = (source: GoatManagedCapabilitySource, enabled: boolean) => {
    setError(null);
    setPendingSource(source);
    startTransition(async () => {
      try {
        const result = await setWorkspaceCapabilityAction({ source, enabled });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setRows((current) =>
          current.map((row) => (row.source === source ? { ...row, enabled } : row)),
        );
        router.refresh();
      } catch {
        setError("Could not update the capability. Try again.");
      } finally {
        setPendingSource(null);
      }
    });
  };

  return (
    <GoatSettingsContent
      title="Capabilities"
      description="Choose which managed research and enrichment sources are available in the main chat."
    >
      <section className="overflow-hidden rounded-lg border border-ink/10">
        {rows.map((row, index) => {
          const copy = CAPABILITY_COPY[row.source];
          return (
            <div
              key={row.source}
              className={`flex items-center gap-5 px-4 py-3.5 ${
                index > 0 ? "border-t border-ink/10" : ""
              }`}
            >
              <div className="min-w-0 flex-1">
                <h2 className="text-[14px] font-medium text-ink">{copy.label}</h2>
                <p className="mt-0.5 text-[12px] leading-4 text-ink-subtle">{copy.description}</p>
              </div>
              <Switch
                checked={row.enabled}
                onCheckedChange={(enabled) => setEnabled(row.source, enabled)}
                disabled={!isAdmin || pendingSource !== null}
                aria-label={`${row.enabled ? "Disable" : "Enable"} ${copy.label}`}
              />
            </div>
          );
        })}
      </section>

      <div className="flex flex-col gap-2 text-[12px] leading-5 text-ink-subtle">
        <p>
          Usage is charged to workspace credits at the underlying provider cost plus a 20% platform
          fee. Chat asks for one-time approval before higher-cost actions.
        </p>
        <p>
          These are managed capabilities, not connected integrations. Results are saved to Brain
          only when someone explicitly asks.
        </p>
        {!isAdmin ? <p>Only workspace admins can change these settings.</p> : null}
        {error ? (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        ) : null}
      </div>
    </GoatSettingsContent>
  );
}
