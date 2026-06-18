"use client";

import {
  DEFAULT_GROUP_STANCE,
  type PermissionGroup,
  POLICY_DECISIONS,
  type PolicyDecision,
  PROVIDER_PERMISSION_REGISTRY,
  permissionDescriptionFor,
  permissionLabelFor,
} from "@opencompany/agent-runtime";
import { useState, useTransition } from "react";
import { useToast } from "@/components/ToastProvider";
import { setWorkspaceToolPolicy } from "@/lib/tool-policies/actions";

const DECISION_LABELS: Record<PolicyDecision, string> = {
  allow: "Allow",
  ask: "Ask first",
  deny: "Deny",
};

export type ToolPolicyEditorProps = {
  providerKey: string;
  // Sparse saved overrides; missing groups fall back to the default stance.
  overrides?: Partial<Record<PermissionGroup, PolicyDecision>> | undefined;
};

export function ToolPolicyEditor({ providerKey, overrides }: ToolPolicyEditorProps) {
  const spec = PROVIDER_PERMISSION_REGISTRY[providerKey];
  const { showError } = useToast();
  const [decisions, setDecisions] = useState<Partial<Record<PermissionGroup, PolicyDecision>>>(
    overrides ?? {},
  );
  const [isPending, startTransition] = useTransition();

  if (!spec || !spec.gated) return null;

  const decisionFor = (group: PermissionGroup): PolicyDecision =>
    decisions[group] ?? DEFAULT_GROUP_STANCE[group];

  const update = (group: PermissionGroup, decision: PolicyDecision) => {
    const previous = decisions[group];
    setDecisions((current) => ({ ...current, [group]: decision }));
    const revert = () => {
      setDecisions((current) => ({
        ...current,
        [group]: previous ?? DEFAULT_GROUP_STANCE[group],
      }));
    };
    startTransition(async () => {
      try {
        const result = await setWorkspaceToolPolicy({
          providerKey,
          permissionGroup: group,
          decision,
        });
        if (!result.ok) {
          // Revert the optimistic change on failure.
          revert();
          showError(result.error);
        }
      } catch {
        // A thrown server-action error must not escalate to the route error
        // boundary and tear down a surrounding flow (e.g. the onboarding wizard).
        revert();
        showError("Couldn't update this permission. Please try again.");
      }
    });
  };

  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <p className="text-[11.5px] font-medium text-ink-muted">What this agent can do here</p>
      {spec.groups.map((group) => (
        <div key={group} className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium text-ink">
              {permissionLabelFor(providerKey, group)}
            </div>
            <div className="text-[11px] leading-4 text-ink-subtle">
              {permissionDescriptionFor(providerKey, group)}
            </div>
          </div>
          <div
            role="radiogroup"
            aria-label={`${permissionLabelFor(providerKey, group)} permission`}
            className="inline-flex shrink-0 overflow-hidden rounded-md border border-border"
          >
            {POLICY_DECISIONS.map((decision) => {
              const selected = decisionFor(group) === decision;
              return (
                <button
                  key={decision}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={isPending}
                  onClick={() => {
                    if (!selected) update(group, decision);
                  }}
                  className={`h-6 px-2.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed ${
                    selected
                      ? decision === "deny"
                        ? "bg-danger-bg text-danger"
                        : decision === "ask"
                          ? "bg-warning-bg text-warning"
                          : "bg-success-bg text-success"
                      : "bg-surface text-ink-subtle hover:bg-surface-muted"
                  }`}
                >
                  {DECISION_LABELS[decision]}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
