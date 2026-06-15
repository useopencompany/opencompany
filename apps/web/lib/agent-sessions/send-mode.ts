// Send-mode is how a user message is dispatched when a run is already in flight. The composer
// surfaces it as a picker (the colored button next to send) and persists the choice per device.
// The server action and the runner act on it; see actions.ts (submitAgentSessionMessage) and the
// runner's session-lifecycle.ts. When the session is idle the mode is irrelevant — any send just
// starts a turn — so this only changes behavior mid-run.
//
// NOTE: kept out of actions.ts on purpose — that file is "use server" and may only export async
// functions, so shared types/constants live here where both server and client can import them.

export type SendMode = "steer" | "queue" | "interrupt";

export const DEFAULT_SEND_MODE: SendMode = "steer";

// localStorage key for the sticky per-device default the composer restores on load.
export const SEND_MODE_STORAGE_KEY = "oc.composer.send-mode";

export function isSendMode(value: unknown): value is SendMode {
  return value === "steer" || value === "queue" || value === "interrupt";
}

export type SendModeMeta = {
  value: SendMode;
  label: string;
  // One-line explanation shown in the picker.
  description: string;
  // Tailwind color tokens for the active pill. Steer is green (the "go" / live-nudge mode),
  // queue is muted, interrupt is danger.
  activeClassName: string;
  dotClassName: string;
};

export const SEND_MODES: SendModeMeta[] = [
  {
    value: "steer",
    label: "Steer",
    description: "Nudge the agent at its next step. Keeps in-progress work.",
    activeClassName: "border-success-border bg-success-bg text-success",
    dotClassName: "bg-success",
  },
  {
    value: "queue",
    label: "Queue",
    description: "Wait for the current turn to finish, then send.",
    activeClassName: "border-warning-border bg-warning-bg text-warning",
    dotClassName: "bg-warning",
  },
  {
    value: "interrupt",
    label: "Interrupt",
    description: "Stop the current turn now (drops in-progress work) and send.",
    activeClassName: "border-danger-border bg-danger-bg text-danger",
    dotClassName: "bg-danger",
  },
];

export function sendModeMeta(mode: SendMode): SendModeMeta {
  return SEND_MODES.find((m) => m.value === mode) ?? SEND_MODES[0]!;
}
