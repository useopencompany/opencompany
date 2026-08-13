"use server";

import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

// A small feedback report from the sidebar widget. Bug / Feedback / Idea only —
// the Linear dispatch lives in the canonical API's feedback service.
type GoatFeedbackKind = "bug" | "feedback" | "idea";

export type GoatFeedbackActionState = { ok: true } | { ok: false; error: string };

function isGoatFeedbackKind(value: string): value is GoatFeedbackKind {
  return value === "bug" || value === "feedback" || value === "idea";
}

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function submitGoatFeedback(
  _previousState: GoatFeedbackActionState | null,
  formData: FormData,
): Promise<GoatFeedbackActionState> {
  const rawKind = readString(formData, "kind");
  const message = readString(formData, "message");
  const kind = isGoatFeedbackKind(rawKind) ? rawKind : "feedback";

  if (message.length < 3) {
    return { ok: false, error: "Enter a bit more detail." };
  }
  if (message.length > 4000) {
    return { ok: false, error: "Keep feedback under 4,000 characters." };
  }

  try {
    const response = await (await serverApiClient()).v1.feedback.$post({
      json: { kind, message },
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
