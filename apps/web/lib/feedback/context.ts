// The chat session or task a reporter had open when they pressed Feedback.
// Derived from the route rather than the raw pathname so we only ever send the
// two references triage can act on.
export type FeedbackContext = { kind: "chat" | "task"; id: string };

const CONTEXT_ROUTES: Array<{ segment: string; kind: FeedbackContext["kind"] }> = [
  { segment: "chat", kind: "chat" },
  { segment: "tasks", kind: "task" },
];

export function feedbackContextFromPathname(pathname: string | null): FeedbackContext | null {
  if (!pathname) return null;
  const [first, second] = pathname.split("/").filter(Boolean);
  const route = CONTEXT_ROUTES.find((candidate) => candidate.segment === first);
  if (!route || !second) return null;

  let id: string;
  try {
    id = decodeURIComponent(second).trim();
  } catch {
    // A malformed escape means this isn't an id we can reference; skip it
    // rather than attaching a value the API would reject.
    return null;
  }
  if (!id || id.length > 128) return null;

  return { kind: route.kind, id };
}

export function feedbackContextLabel(context: FeedbackContext) {
  return context.kind === "chat" ? "this chat session" : "this task";
}
