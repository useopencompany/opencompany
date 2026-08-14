"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { BookOpen, ExternalLink, LoaderCircle } from "lucide-react";
import { AttioIntegrationSetup } from "@/components/AttioIntegrationSetup";
import { FathomIntegrationSetup } from "@/components/FathomIntegrationSetup";
import { GranolaIntegrationSetup } from "@/components/GranolaIntegrationSetup";
import { JamieIntegrationSetup } from "@/components/JamieIntegrationSetup";
import type { BrainSourcesDetails } from "@/lib/brain-source-actions";
import type { BrainSourceProviderDef } from "@/lib/brain-sources/registry";

// In-wizard connect surface for the non-OAuth providers (api_key + webhook).
// OAuth providers still route through the popup + /onboarding/connected bridge;
// only providers whose connectionKind !== "oauth" reach here.
export function ConnectIntegrationModal({
  provider,
  details,
  onClose,
  onConnected,
}: {
  provider: BrainSourceProviderDef;
  details: BrainSourcesDetails | null;
  onClose: () => void;
  onConnected: (providerId: BrainSourceProviderDef["id"]) => void;
}) {
  const Icon = provider.icon;
  const handleConnected = () => onConnected(provider.id);

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
            Connect {provider.name}
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-4 text-ink-subtle">
            {provider.description}
          </DialogDescription>
          {provider.docsHref ? (
            <a
              href={provider.docsHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-1.5 pt-1 text-[11.5px] font-medium text-ink-subtle transition-colors hover:text-ink"
            >
              <BookOpen size={12} strokeWidth={1.9} />
              Setup guide
              <ExternalLink size={11} strokeWidth={1.9} />
            </a>
          ) : null}
        </DialogHeader>

        <div className="pt-2">
          <ConnectIntegrationForm
            provider={provider}
            details={details}
            onConnected={handleConnected}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConnectIntegrationForm({
  provider,
  details,
  onConnected,
}: {
  provider: BrainSourceProviderDef;
  details: BrainSourcesDetails | null;
  onConnected: () => void;
}) {
  // Fresh brains open the modal before the first sources fetch resolves; show a
  // loading row until reload() populates the initial state the forms need.
  if (!details) {
    return (
      <div className="flex items-center gap-2 px-2 py-6 text-[12px] text-ink-subtle">
        <LoaderCircle size={14} strokeWidth={2} className="animate-spin" />
        Loading connection…
      </div>
    );
  }

  switch (provider.id) {
    case "granola":
      return (
        <GranolaIntegrationSetup
          initialState={details.granola.integration}
          variant="modal"
          onSaved={onConnected}
        />
      );
    case "fathom":
      return (
        <FathomIntegrationSetup
          initialState={details.fathom.integration}
          variant="modal"
          onSaved={onConnected}
        />
      );
    case "attio":
      return (
        <AttioIntegrationSetup
          initialState={details.attio.integration}
          variant="modal"
          onSaved={onConnected}
        />
      );
    case "jamie":
      return (
        <JamieIntegrationSetup
          initialState={details.jamie.integration}
          variant="modal"
          canManage={details.viewer.isAdmin}
          onSaved={onConnected}
        />
      );
    default:
      return null;
  }
}
