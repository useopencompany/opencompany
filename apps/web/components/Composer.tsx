"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ComposerVariant = "expanded" | "compact";

// Two sizes of the same chrome. "expanded" is the hero composer on the root route;
// "compact" is the in-session follow-up composer. Only padding/typography differ — the
// structure (input region on top, a toolbar tray below) is identical so the two stay
// visually consistent.
const VARIANT_STYLES: Record<ComposerVariant, { card: string; inputRegion: string; bar: string }> =
  {
    expanded: {
      card: "rounded-2xl",
      // Symmetric vertical padding so the items-end action centers on a single line.
      inputRegion: "px-4 py-3",
      bar: "rounded-b-2xl px-2.5 py-2",
    },
    compact: {
      card: "rounded-xl",
      inputRegion: "px-3.5 py-2.5",
      bar: "rounded-b-xl px-2 py-1.5",
    },
  };

type ComposerProps = {
  variant?: ComposerVariant;
  /** The text-entry surface (a textarea). Owned by the caller, including all handlers. */
  input: ReactNode;
  /** Pinned to the right of the input region — the send / stop button. */
  action?: ReactNode;
  /** Toolbar tray — left cluster (attach, agent/model selectors). */
  leftControls?: ReactNode;
  /** Toolbar tray — right cluster (keyboard hints). */
  rightControls?: ReactNode;
  /** Rendered above the card (e.g. the interrupted-session banner). */
  banner?: ReactNode;
  /** Inline error rendered above the card. */
  error?: ReactNode;
  /** Floating layer anchored to the card (e.g. the slash-command menu). */
  overlay?: ReactNode;
  className?: string;
};

// The shared chat composer chrome: a bordered card whose top holds the text input and whose
// bottom holds a recessed toolbar tray for controls — the agent/model selectors, attach, and
// the send button. It is purely presentational: the caller supplies the textarea and the
// controls as slots, so all behavior (slash commands, abort, optimistic send, etc.) stays
// where it already lives. `group/composer` is exposed so controls can reveal on focus with
// `group-focus-within/composer:…`.
export function Composer({
  variant = "compact",
  input,
  action,
  leftControls,
  rightControls,
  banner,
  error,
  overlay,
  className,
}: ComposerProps) {
  const styles = VARIANT_STYLES[variant];

  return (
    <div className={cn("group/composer", className)}>
      {error ? <p className="mb-2 text-[12px] text-danger">{error}</p> : null}
      {banner}
      <div
        className={cn(
          "oc-composer-card",
          "relative border border-border bg-surface shadow-[0_1px_2px_rgba(15,15,15,0.03)] transition-shadow focus-within:border-border-strong focus-within:shadow-[0_1px_2px_rgba(15,15,15,0.04),0_0_0_3px_rgba(15,15,15,0.05)]",
          styles.card,
        )}
      >
        {overlay}
        <div
          className={cn(
            "oc-composer-input-region relative flex items-end gap-2",
            styles.inputRegion,
          )}
        >
          <div className="oc-composer-input-slot min-w-0 flex-1">{input}</div>
          {/* min-h matches the single-line textarea so items-center vertically centers the
              button on one line, while items-end keeps it by the last line as it grows. */}
          {action ? <div className="flex min-h-9 shrink-0 items-center">{action}</div> : null}
        </div>
        <div
          className={cn(
            "oc-composer-toolbar",
            "flex items-center justify-between gap-2 border-t border-border bg-canvas",
            styles.bar,
          )}
        >
          <div className="flex min-w-0 items-center gap-0.5">{leftControls}</div>
          <div className="flex shrink-0 items-center gap-2">{rightControls}</div>
        </div>
      </div>
    </div>
  );
}
