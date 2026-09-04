"use server";

import { randomUUID } from "node:crypto";
import type { OnboardingStateDto } from "@opencompany/protocol";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { currentIdentity } from "@/lib/auth";
import { enrollOwnerInOnboardingEmails } from "@/lib/email/onboarding-emails";
import { parseOnboardingProfile } from "@/lib/onboarding-profile";
import { serverApiClient, serverApiError, serverApiErrorMessage } from "@/lib/server-api-client";
import { activateWorkspace } from "@/lib/workspace-session";

export type OnboardingActionResult = { ok: true } | { ok: false; error: string };
export type OnboardingWorkspaceActionResult =
  | { ok: true; workspaceId: string; brainRef: string | null }
  | { ok: false; error: string };

const WORKSPACE_SAVE_ERROR = "Could not save your workspace. Please try again.";

function normalizeWorkspaceSlug(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export async function getOnboardingState(): Promise<OnboardingStateDto> {
  const response = await (await serverApiClient()).v1.onboarding.$get();
  if (!response.ok) throw await serverApiError(response, "Could not load onboarding.");
  return (await response.json()).data;
}

export async function checkWorkspaceSlugAction(
  rawSlug: unknown,
): Promise<{ slug: string; available: boolean }> {
  const slug = normalizeWorkspaceSlug(rawSlug);
  if (!slug) return { slug, available: false };
  const response = await (await serverApiClient()).v1.onboarding["workspace-slug"].check.$post({
    json: { slug },
  });
  if (!response.ok) return { slug, available: false };
  return (await response.json()).data;
}

export async function saveOnboardingWorkspaceAction(input: {
  name: string;
  slug: string;
}): Promise<OnboardingWorkspaceActionResult> {
  const candidate = input as Partial<typeof input> | null | undefined;
  const name = typeof candidate?.name === "string" ? candidate.name.trim() : "";
  if (!name) return { ok: false, error: "Enter a company name." };
  if (name.length > 80) return { ok: false, error: "Name is too long (max 80 chars)." };

  const slug = normalizeWorkspaceSlug(candidate?.slug);
  if (!slug) return { ok: false, error: "Enter a valid workspace URL." };

  const workspaceId = `goat_ws_${randomUUID()}`;
  try {
    const response = await (await serverApiClient()).v1.onboarding.workspace.$put({
      json: { workspaceId, name, slug },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, WORKSPACE_SAVE_ERROR),
      };
    }
    const activation = (await response.json()).data;

    if (activation.createdByCaller) {
      const identity = await currentIdentity();
      await enrollOwnerInOnboardingEmails({
        workosUserId: identity.user.workosUserId,
      }).catch((error) => {
        console.error("[opencompany] Failed to enroll owner in onboarding emails", {
          workspaceId: activation.workspaceId,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
    }

    await activateWorkspace({
      workspaceId: activation.workspaceId,
      workosOrganizationId: activation.organizationId,
      brainId: activation.brainId,
    });
    revalidatePath("/", "layout");
    return {
      ok: true,
      workspaceId: activation.workspaceId,
      brainRef: activation.brainId,
    };
  } catch (error) {
    unstable_rethrow(error);
    console.error(
      "[opencompany] Failed to save the onboarding workspace through the canonical API",
      {
        workspaceId,
        errorName: error instanceof Error ? error.name : typeof error,
      },
    );
    return { ok: false, error: WORKSPACE_SAVE_ERROR };
  }
}

export async function saveOnboardingProfileAction(input: {
  role: string | null;
  companyUrl: string;
}): Promise<OnboardingActionResult> {
  const profile = parseOnboardingProfile(input);
  if (!profile.ok) return profile;
  try {
    const response = await (await serverApiClient()).v1.onboarding.profile.$put({
      json: { role: profile.role, companyUrl: profile.companyUrl },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not save your profile."),
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not save your profile.",
    };
  }
}

export async function finishOnboardingAction(input: {
  referralSource: string | null;
}): Promise<OnboardingActionResult> {
  const referralSource =
    typeof input?.referralSource === "string" ? input.referralSource.trim() || null : null;
  try {
    const response = await (await serverApiClient()).v1.onboarding.complete.$post({
      json: { referralSource },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not finish onboarding."),
      };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not finish onboarding.",
    };
  }
}
