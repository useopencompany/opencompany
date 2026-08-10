"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { CircleAlert } from "lucide-react";
import {
  AttioObjectPicker,
  GitHubRepoPicker,
  GmailSourceEditor,
  GoogleDriveSourceEditor,
  goatBrainSourceHasScope,
  HubspotObjectPicker,
  LinearTeamPicker,
  resolveGoatBrainSourceState,
  SlackChannelPicker,
} from "@/components/GoatBrainSourceCards";
import type { GoatBrainSourcesDetails } from "@/lib/brain-source-actions";
import type { GoatBrainSourceProviderDef } from "@/lib/brain-sources/registry";

// Per-provider framing for the focused config surface. Kept intentionally short
// and action-first: the picker below already carries the mechanics.
const CONFIG_HINT: Partial<Record<GoatBrainSourceProviderDef["id"], string>> = {
  slack:
    "Pick the channels whose conversations should flow into your Brain. Start with your most active ones — you can change this anytime.",
  linear: "Choose the teams whose issue and comment activity should feed your Brain.",
  github: "Choose the repositories whose pull requests and issues should feed your Brain.",
  gmail:
    "Confirm which email should flow into your Brain. Add instructions to narrow it to what matters.",
  google_drive: "Choose the files and folders whose changes should feed your Brain.",
  hubspot: "Choose which CRM objects and activity should feed your Brain.",
  attio: "Choose which CRM objects and activity should feed your Brain.",
};

// Opened the moment a config-requiring source finishes authorizing. Reuses the
// exact pickers from the brain settings surface (rendered expanded) so scope
// selection happens in one focused motion instead of being buried in a collapsed
// row the user can walk past.
export function SourceConfigSheet({
  brainRef,
  provider,
  details,
  onClose,
  onChanged,
}: {
  brainRef: string;
  provider: GoatBrainSourceProviderDef;
  details: GoatBrainSourcesDetails | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const Icon = provider.icon;
  const state = resolveGoatBrainSourceState(provider.id, details);
  const integrationId = state.integrationId;
  const feeding = state.enabled && goatBrainSourceHasScope(provider.id, state.source?.config);

  const pickerProps = integrationId
    ? {
        brainRef,
        integrationId,
        source: state.source,
        onChanged,
        defaultExpanded: true,
      }
    : null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] max-w-[560px] overflow-y-auto">
        <DialogHeader className="text-left">
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink">
              <Icon size={15} strokeWidth={1.9} />
            </span>
            {provider.name} → your Brain
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-4 text-ink-subtle">
            {CONFIG_HINT[provider.id] ?? provider.description}
          </DialogDescription>
        </DialogHeader>

        <div className="pt-1">
          {pickerProps ? (
            <SourcePicker providerId={provider.id} {...pickerProps} />
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2.5 text-[12px] leading-4 text-ink-subtle">
              <CircleAlert size={14} strokeWidth={2} className="shrink-0 text-warning" />
              Reconnect {provider.name} to choose what feeds your Brain.
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <span className="text-[11.5px] leading-4 text-ink-subtle">
            {feeding
              ? "Feeding your Brain — you can refine this later in settings."
              : "Save your selection above to start feeding your Brain."}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md bg-ink px-3.5 py-2 text-[12.5px] font-semibold text-canvas transition-opacity hover:opacity-90"
          >
            Done
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SourcePicker({
  providerId,
  ...props
}: {
  providerId: GoatBrainSourceProviderDef["id"];
} & React.ComponentProps<typeof SlackChannelPicker>) {
  switch (providerId) {
    case "slack":
      return <SlackChannelPicker {...props} />;
    case "linear":
      return <LinearTeamPicker {...props} />;
    case "github":
      return <GitHubRepoPicker {...props} />;
    case "gmail":
      return <GmailSourceEditor {...props} />;
    case "google_drive":
      return <GoogleDriveSourceEditor {...props} />;
    case "hubspot":
      return <HubspotObjectPicker {...props} />;
    case "attio":
      return <AttioObjectPicker {...props} />;
    default:
      return null;
  }
}
