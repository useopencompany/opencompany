"use server";

import {
  hasOwnedGoatHobbyWorkspace,
  isGoatWorkspaceSlugAvailable,
  markGoatUserOnboarded,
  updateGoatWorkspaceNameAndSlug,
  upsertGoatOnboarding,
} from "@opencompany/db/goat-workspaces";
import {
  ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS,
  HARD_DEFAULT_GOAT_BRAIN_FOLDERS,
  normalizeGoatBrainFolder,
} from "@opencompany/goat-brain/schema";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { currentGoatIdentity, currentGoatUser } from "@/lib/auth";
import { createGoatBrainFolderForUser, deleteGoatBrainFolderForUser } from "@/lib/brain";
import { enrollOwnerInOnboardingEmails } from "@/lib/email/onboarding-emails";
import { parseGoatOnboardingProfile } from "@/lib/onboarding-profile";
import { getWorkOSClient } from "@/lib/workos-client";
import { ensureGoatWorkspaceOrganization } from "@/lib/workos-organizations";
import {
  GoatWorkspaceProvisioningError,
  provisionGoatWorkspace,
} from "@/lib/workspace-provisioning";
import { activateGoatWorkspace } from "@/lib/workspace-session";

export type GoatOnboardingActionResult = { ok: true } | { ok: false; error: string };
export type GoatOnboardingWorkspaceActionResult =
  | { ok: true; workspaceId: string; brainRef: string }
  | { ok: false; error: string };

const WORKSPACE_SAVE_ERROR = "Could not save your workspace. Please try again.";

function errorResult(error: unknown, fallback: string): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

// Mirrors the client-side slugify so what the user previews is what we store.
function normalizeGoatWorkspaceSlug(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export async function checkGoatWorkspaceSlugAction(
  rawSlug: unknown,
): Promise<{ slug: string; available: boolean }> {
  await currentGoatIdentity();
  const context = await currentGoatUser({ optional: true });
  const slug = normalizeGoatWorkspaceSlug(rawSlug);
  if (!slug) return { slug, available: false };
  const available = await isGoatWorkspaceSlugAvailable({
    slug,
    ...(context ? { excludeWorkspaceId: context.workspace.id } : {}),
  });
  return { slug, available };
}

export async function saveGoatOnboardingWorkspaceAction(input: {
  name: string;
  slug: string;
}): Promise<GoatOnboardingWorkspaceActionResult> {
  const identity = await currentGoatIdentity();
  const context = await currentGoatUser({ optional: true });
  // Server actions are public boundaries at runtime even when callers are
  // typechecked, so do not trust the serialized payload shape.
  const candidate = input as Partial<typeof input> | null | undefined;
  const name = typeof candidate?.name === "string" ? candidate.name.trim() : "";
  if (!name) return { ok: false, error: "Enter a company name." };
  if (name.length > 80) return { ok: false, error: "Name is too long (max 80 chars)." };

  const slug = normalizeGoatWorkspaceSlug(candidate?.slug);
  if (!slug) return { ok: false, error: "Enter a valid workspace URL." };
  if (context?.role !== undefined && context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can set this up." };
  }

  try {
    const available = await isGoatWorkspaceSlugAvailable({
      slug,
      ...(context ? { excludeWorkspaceId: context.workspace.id } : {}),
    });
    if (!available) return { ok: false, error: "That workspace URL is taken." };

    if (context) {
      const brain = context.activeBrain ?? context.brains[0];
      if (!brain) return { ok: false, error: "No brain is available for this workspace." };
      const workosOrganizationId =
        context.workspace.workosOrganizationId ??
        (await ensureGoatWorkspaceOrganization(context.workspace));
      await getWorkOSClient().organizations.updateOrganization({
        organization: workosOrganizationId,
        name,
      });
      await updateGoatWorkspaceNameAndSlug({ workspaceId: context.workspace.id, name, slug });
      await upsertGoatOnboarding({
        userWorkosId: identity.user.workosUserId,
        workspaceId: context.workspace.id,
      });
      await activateGoatWorkspace({
        workspaceId: context.workspace.id,
        workosOrganizationId,
        brainId: brain.id,
      });
      revalidatePath("/", "layout");
      return { ok: true, workspaceId: context.workspace.id, brainRef: brain.id };
    }

    if (await hasOwnedGoatHobbyWorkspace(identity.user.workosUserId)) {
      return { ok: false, error: "Your existing Hobby workspace could not be loaded." };
    }

    const created = await provisionGoatWorkspace({
      authUserId: identity.authUser.id,
      userWorkosId: identity.user.workosUserId,
      name,
      slug,
    });
    await upsertGoatOnboarding({
      userWorkosId: identity.user.workosUserId,
      workspaceId: created.workspace.id,
    });
    await enrollOwnerInOnboardingEmails({
      workosUserId: identity.user.workosUserId,
    }).catch((error) => {
      console.error("[goat] Failed to enroll owner in onboarding emails", error);
    });
    await activateGoatWorkspace({
      workspaceId: created.workspace.id,
      workosOrganizationId: created.workspace.workosOrganizationId,
      brainId: created.brain.id,
    });
    revalidatePath("/", "layout");
    return { ok: true, workspaceId: created.workspace.id, brainRef: created.brain.id };
  } catch (error) {
    unstable_rethrow(error);
    const provisioning = error instanceof GoatWorkspaceProvisioningError ? error : null;
    console.error("[goat] Failed to save the onboarding workspace", {
      userWorkosId: identity.user.workosUserId,
      workspaceId: context?.workspace.id ?? provisioning?.workspaceId,
      workosOrganizationId:
        context?.workspace.workosOrganizationId ?? provisioning?.workosOrganizationId,
      localWorkspacePersisted: provisioning?.localWorkspacePersisted,
      error,
    });
    return { ok: false, error: WORKSPACE_SAVE_ERROR };
  }
}

export async function saveGoatOnboardingBrainFoldersAction(input: {
  folders: string[];
}): Promise<GoatOnboardingActionResult> {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can set this up." };
  }
  const brain = context.activeBrain;
  if (!brain) return { ok: false, error: "No brain to configure." };

  const target = new Set(
    input.folders.map((f) => normalizeGoatBrainFolder(f)).filter((f) => f.length > 0),
  );
  const hard = new Set<string>(HARD_DEFAULT_GOAT_BRAIN_FOLDERS);
  const adjustable = new Set<string>(ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS);
  const userWorkosId = context.user.workosUserId;

  // Reconcile the seeded adjustable defaults with what the user kept, then add
  // any custom folders. Mutations are idempotent, so we ignore no-op failures.
  for (const folder of ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS) {
    if (target.has(folder)) {
      await createGoatBrainFolderForUser({ brainRef: brain.id, userWorkosId, folderPath: folder });
    } else {
      await deleteGoatBrainFolderForUser({ brainRef: brain.id, userWorkosId, folderPath: folder });
    }
  }
  for (const folder of target) {
    if (hard.has(folder) || adjustable.has(folder)) continue;
    await createGoatBrainFolderForUser({ brainRef: brain.id, userWorkosId, folderPath: folder });
  }

  revalidatePath("/", "layout");
  return { ok: true };
}

export async function saveGoatOnboardingProfileAction(input: {
  role: string | null;
  companyUrl: string;
}): Promise<GoatOnboardingActionResult> {
  const identity = await currentGoatIdentity();
  const context = await currentGoatUser({ optional: true });
  const profile = parseGoatOnboardingProfile(input);
  if (!profile.ok) return profile;
  try {
    await upsertGoatOnboarding({
      userWorkosId: identity.user.workosUserId,
      workspaceId: context?.workspace.id ?? null,
      role: profile.role,
      building: null,
      companyDomain: new URL(profile.companyUrl).hostname,
      contextUrls: [profile.companyUrl],
    });
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not save your profile.");
  }
}

export async function finishGoatOnboardingAction(input: {
  referralSource: string | null;
}): Promise<GoatOnboardingActionResult> {
  const context = await currentGoatUser();
  try {
    await upsertGoatOnboarding({
      userWorkosId: context.user.workosUserId,
      workspaceId: context.workspace.id,
      referralSource: input.referralSource?.trim() || null,
    });
    await markGoatUserOnboarded(context.user.workosUserId);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not finish onboarding.");
  }
}
