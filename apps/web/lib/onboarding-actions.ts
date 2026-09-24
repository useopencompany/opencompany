"use server";

import { newResourceId } from "@opencompany/core/resource-ids";
import type { OnboardingRepositoryScan, OnboardingStateDto } from "@opencompany/protocol";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { currentIdentity } from "@/lib/auth";
import { loadCurrentClaudeCodeAuthSettings } from "@/lib/claude-code-auth";
import { loadCurrentCodexAuthSettings } from "@/lib/codex-auth";
import { enrollOwnerInOnboardingEmails } from "@/lib/email/onboarding-emails";
import { listHeadlessPlugins } from "@/lib/headless-knowledge-server";
import { parseOnboardingProfile } from "@/lib/onboarding-profile";
import { serverApiClient, serverApiError, serverApiErrorMessage } from "@/lib/server-api-client";
import { activateWorkspace } from "@/lib/workspace-session";

export type OnboardingActionResult = { ok: true } | { ok: false; error: string };
export type OnboardingWorkspaceActionResult =
  | { ok: true; workspaceId: string }
  | { ok: false; error: string };

const WORKSPACE_SAVE_ERROR = "Could not save your workspace. Please try again.";

export async function getOnboardingState(): Promise<OnboardingStateDto> {
  const response = await (await serverApiClient()).v1.onboarding.$get();
  if (!response.ok) throw await serverApiError(response, "Could not load onboarding.");
  return (await response.json()).data;
}

export async function saveOnboardingWorkspaceAction(input: {
  name: string;
}): Promise<OnboardingWorkspaceActionResult> {
  const candidate = input as Partial<typeof input> | null | undefined;
  const name = typeof candidate?.name === "string" ? candidate.name.trim() : "";
  if (!name) return { ok: false, error: "Enter a company name." };
  if (name.length > 80) return { ok: false, error: "Name is too long (max 80 chars)." };

  const workspaceId = newResourceId("workspace");
  try {
    const response = await (await serverApiClient()).v1.onboarding.workspace.$put({
      json: { workspaceId, name },
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
    });
    revalidatePath("/", "layout");
    return {
      ok: true,
      workspaceId: activation.workspaceId,
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

export type OnboardingSubscriptionsState = {
  claudeCode: { connected: boolean; needsReauth: boolean };
  codex: { connected: boolean; needsReauth: boolean };
};

// Onboarding reads connection status rather than receiving it as a prop: the
// page renders before the workspace exists, and both providers can be connected
// from a popup/device flow while the wizard stays mounted. A read failure must
// not block setup, so an unreachable provider reads as "not connected".
export async function getOnboardingSubscriptionsAction(): Promise<OnboardingSubscriptionsState> {
  const [claudeCode, codex] = await Promise.all([
    loadCurrentClaudeCodeAuthSettings().catch(() => null),
    loadCurrentCodexAuthSettings().catch(() => null),
  ]);
  return {
    claudeCode: {
      connected: claudeCode?.status === "connected",
      needsReauth: claudeCode?.status === "needs_reauth",
    },
    codex: {
      connected: codex?.status === "connected",
      needsReauth: codex?.status === "needs_reauth",
    },
  };
}

// Names of the plugins already installed in the workspace, so a resumed
// onboarding shows what is really there instead of an empty catalog.
export async function getOnboardingInstalledPluginsAction(): Promise<string[]> {
  try {
    const plugins = await listHeadlessPlugins();
    return plugins.map((plugin) => plugin.name);
  } catch {
    return [];
  }
}

export type OnboardingRepositoryScanResult =
  | { ok: true; scan: OnboardingRepositoryScan }
  | { ok: false; error: string };

// Reads the founder's most recently pushed repository, or the one they picked, and returns the
// plugins its setup files point at. The API re-checks that the repository is theirs.
export async function scanOnboardingRepositoryAction(input: {
  repository?: string;
}): Promise<OnboardingRepositoryScanResult> {
  const repository = typeof input?.repository === "string" ? input.repository.trim() : "";
  try {
    const response = await (await serverApiClient()).v1.onboarding["repository-scan"].$post({
      json: repository ? { repository } : {},
    });
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not read your repository."),
      };
    }
    return { ok: true, scan: (await response.json()).data };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, error: "Could not read your repository. Please try again." };
  }
}
