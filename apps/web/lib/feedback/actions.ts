"use server";

import { feedbackContextFromPathname } from "@/lib/feedback/context";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

// A small feedback report from the sidebar widget. Bug / Feedback / Idea only —
// the Linear dispatch lives in the canonical API's feedback service.
type FeedbackKind = "bug" | "feedback" | "idea";

export type FeedbackActionState = { ok: true } | { ok: false; error: string };

function isFeedbackKind(value: string): value is FeedbackKind {
  return value === "bug" || value === "feedback" || value === "idea";
}

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function submitFeedback(
  _previousState: FeedbackActionState | null,
  formData: FormData,
): Promise<FeedbackActionState> {
  const rawKind = readString(formData, "kind");
  const message = readString(formData, "message");
  const attachmentIds = formData
    .getAll("attachmentId")
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim());
  const kind = isFeedbackKind(rawKind) ? rawKind : "feedback";
  // Re-derive the reference from the submitted path so the action trusts the
  // same route rules as the dialog rather than a client-supplied id.
  const context = feedbackContextFromPathname(readString(formData, "path") || null);

  if (message.length < 3) {
    return { ok: false, error: "Enter a bit more detail." };
  }
  if (message.length > 4000) {
    return { ok: false, error: "Keep feedback under 4,000 characters." };
  }

  try {
    const response = await (await serverApiClient()).v1.feedback.$post({
      json: {
        kind,
        message,
        ...(context ? { context } : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
      },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(
          response,
          "Could not send feedback. Try again in a minute.",
        ),
      };
    }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Could not send feedback. Try again in a minute.",
    };
  }

  return { ok: true };
}
