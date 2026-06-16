// Send-mode is how a user message is dispatched when a run is already in flight. Today the
// composer always uses "steer" (no picker — sending mid-run nudges the agent at its next
// model-step boundary, keeping in-flight work); "queue" and "interrupt" remain in the type and
// the runner's machinery (session-lifecycle.ts) under the hood. When the session is idle the mode
// is irrelevant — any send just starts a turn.
//
// NOTE: kept out of actions.ts on purpose — that file is "use server" and may only export async
// functions, so this shared type/guard lives here where both server and client can import it.

export type SendMode = "steer" | "queue" | "interrupt";

export function isSendMode(value: unknown): value is SendMode {
  return value === "steer" || value === "queue" || value === "interrupt";
}
