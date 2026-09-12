"use client";

import { CreditCard, FilePen, Globe, Plug, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import type { ApprovalKind, ApprovalPresentation } from "./approval-presentation";
import {
  APPROVAL_CARD_ID_ATTRIBUTE,
  APPROVAL_PRIMARY_BUTTON_ATTRIBUTE,
} from "./PendingApprovalBanner";

export type ApprovalChoice = {
  id: string;
  label: string;
  /** Shown in place of the label while this choice is being sent. */
  busyLabel: string;
  /** Keyboard affordance rendered inside the button, matching what the card actually binds. */
  hint?: string;
  disabled?: boolean;
};

const KIND_ICONS: Record<ApprovalKind, typeof Terminal> = {
  terminal: Terminal,
  files: FilePen,
  network: Globe,
  integration: Plug,
  capability: CreditCard,
};

/**
 * The one card every pending approval renders in. A decision is only as good as what the user can
 * see, so the card always leads with where the request comes from, states the decision as a
 * question, and shows the request verbatim — never a summary the user has to trust.
 */
export function ApprovalCard({
  testId,
  approvalId,
  presentation,
  badge = "Approval needed",
  footer,
  allow,
  deny,
  onChoose,
  submitting,
  error,
}: {
  testId: string;
  approvalId: string;
  presentation: ApprovalPresentation;
  /** Header note on the right; carries the price on metered lookups. */
  badge?: string;
  /** Cost, budget, or loading notes rendered between the request and the buttons. */
  footer?: ReactNode;
  /** Approving choices, laid out right to left with the primary one last. */
  allow: ApprovalChoice[];
  deny: ApprovalChoice;
  onChoose: (choiceId: string) => void;
  submitting: string | null;
  error: string | null;
}) {
  const Icon = KIND_ICONS[presentation.kind];

  return (
    <div
      data-testid={testId}
      {...{ [APPROVAL_CARD_ID_ATTRIBUTE]: approvalId }}
      onKeyDown={(event) => {
        // Esc only denies while the user is already on the card, so it can never resolve an
        // approval the user has not looked at.
        if (event.key !== "Escape" || submitting || deny.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        onChoose(deny.id);
      }}
      className="group max-w-[92%] overflow-hidden rounded-xl border border-border-strong bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
    >
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2">
        <Icon size={13} strokeWidth={1.8} className="shrink-0 text-ink-subtle" />
        <span className="min-w-0 truncate text-[11.5px] font-medium text-ink-muted">
          {presentation.source}
        </span>
        <span className="ml-auto shrink-0 text-[10.5px] font-medium uppercase tracking-wide text-ink-subtle">
          {badge}
        </span>
      </div>
      <div className="px-4 py-3">
        <p className="text-[13px] font-semibold leading-5 text-ink">{presentation.question}</p>
        {presentation.description ? (
          <p className="mt-1 text-[12px] leading-5 text-ink-muted">{presentation.description}</p>
        ) : null}
        {presentation.code ? (
          <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-muted px-3 py-2 font-mono text-[11.5px] leading-5 text-ink/80 ring-1 ring-inset ring-border-subtle">
            {presentation.code}
          </pre>
        ) : null}
        {presentation.paths.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {presentation.paths.map((path) => (
              <li
                key={path}
                title={path}
                className="truncate rounded-md bg-surface-muted px-2 py-1 font-mono text-[11px] leading-4 text-ink/75"
              >
                {path}
              </li>
            ))}
          </ul>
        ) : null}
        {presentation.lines.length > 0 ? (
          <dl className="mt-2 space-y-1">
            {presentation.lines.map((line, index) => (
              <div key={`${line.label}-${index}`} className="flex gap-2 text-[12px] leading-5">
                <dt className="w-20 shrink-0 truncate text-ink-subtle" title={line.label}>
                  {line.label}
                </dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words text-ink-muted">
                  {line.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {footer}
        {error ? (
          <p className="mt-2 text-[11px] text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <ApprovalButton
            choice={deny}
            primary={false}
            submitting={submitting}
            onChoose={onChoose}
          />
          <div className="flex flex-wrap items-center gap-2">
            {allow.map((choice, index) => (
              <ApprovalButton
                key={choice.id}
                choice={choice}
                submitting={submitting}
                onChoose={onChoose}
                primary={index === allow.length - 1}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ApprovalButton({
  choice,
  primary,
  submitting,
  onChoose,
}: {
  choice: ApprovalChoice;
  primary: boolean;
  submitting: string | null;
  onChoose: (choiceId: string) => void;
}) {
  const busy = submitting === choice.id;
  return (
    <button
      type="button"
      {...(primary ? { [APPROVAL_PRIMARY_BUTTON_ATTRIBUTE]: "" } : {})}
      disabled={choice.disabled || submitting !== null}
      onClick={() => onChoose(choice.id)}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50 ${
        primary
          ? "bg-ink text-canvas hover:opacity-90"
          : "border border-border text-ink-muted hover:bg-surface-hover"
      }`}
    >
      {busy ? choice.busyLabel : choice.label}
      {choice.hint && !busy ? (
        // Only truthful once the card holds keyboard focus, which is exactly when the shortcut works.
        <kbd
          aria-hidden="true"
          className={`rounded px-1 py-px font-sans text-[10px] font-medium leading-4 opacity-0 transition-opacity group-focus-within:opacity-100 ${
            primary ? "bg-canvas/20 text-canvas" : "bg-ink/5 text-ink-subtle"
          }`}
        >
          {choice.hint}
        </kbd>
      ) : null}
    </button>
  );
}
