"use server";

import { ADJUSTABLE_DEFAULT_BRAIN_FOLDERS } from "@opencompany/brain/schema";
import {
  getOnboarding,
  hasOwnedHobbyWorkspace,
  isWorkspaceSlugAvailable,
  markUserOnboarded,
  updateWorkspaceNameAndSlug,
  upsertOnboarding,
} from "@opencompany/db/workspaces";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { currentIdentity, currentUser } from "@/lib/auth";
import { createBrainFolderForUser, deleteBrainFolderForUser } from "@/lib/brain";
import { enrollOwnerInOnboardingEmails } from "@/lib/email/onboarding-emails";
import { onboardingFoldersForRole, parseOnboardingProfile } from "@/lib/onboarding-profile";
import { getWorkOSClient } from "@/lib/workos-client";
import { ensureWorkspaceOrganization } from "@/lib/workos-organizations";
import { provisionWorkspace, WorkspaceProvisioningError } from "@/lib/workspace-provisioning";
import { activateWorkspace } from "@/lib/workspace-session";

export type OnboardingActionResult = { ok: true } | { ok: false; error: string };
export type OnboardingWorkspaceActionResult =
  | { ok: true; workspaceId: string; brainRef: string }
  | { ok: false; error: string };

const WORKSPACE_SAVE_ERROR = "Could not save your workspace. Please try again.";

function errorResult(error: unknown, fallback: string): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

// Mirrors the client-side slugify so what the user previews is what we store.
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

export async function checkWorkspaceSlugAction(
  rawSlug: unknown,
): Promise<{ slug: string; available: boolean }> {
  await currentIdentity();
  const context = await currentUser({ optional: true });
  const slug = normalizeWorkspaceSlug(rawSlug);
  if (!slug) return { slug, available: false };
  const available = await isWorkspaceSlugAvailable({
    slug,
    ...(context ? { excludeWorkspaceId: context.workspace.id } : {}),
  });
  return { slug, available };
}

export async function saveOnboardingWorkspaceAction(input: {
  name: string;
  slug: string;
}): Promise<OnboardingWorkspaceActionResult> {
  const identity = await currentIdentity();
  const context = await currentUser({ optional: true });
  // Server actions are public boundaries at runtime even when callers are
  // typechecked, so do not trust the serialized payload shape.
  const candidate = input as Partial<typeof input> | null | undefined;
  const name = typeof candidate?.name === "string" ? candidate.name.trim() : "";
  if (!name) return { ok: false, error: "Enter a company name." };
  if (name.length > 80) return { ok: false, error: "Name is too long (max 80 chars)." };

  const slug = normalizeWorkspaceSlug(candidate?.slug);
  if (!slug) return { ok: false, error: "Enter a valid workspace URL." };
  if (context?.role !== undefined && context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can set this up." };
  }

  try {
    const available = await isWorkspaceSlugAvailable({
      slug,
      ...(context ? { excludeWorkspaceId: context.workspace.id } : {}),
    });
    if (!available) return { ok: false, error: "That workspace URL is taken." };

    if (context) {
      const brain = context.activeBrain ?? context.brains[0];
      if (!brain) return { ok: false, error: "No brain is available for this workspace." };
      const workosOrganizationId =
        context.workspace.workosOrganizationId ??
        (await ensureWorkspaceOrganization(context.workspace));
      await getWorkOSClient().organizations.updateOrganization({
        organization: workosOrganizationId,
        name,
      });
      await updateWorkspaceNameAndSlug({ workspaceId: context.workspace.id, name, slug });
      await upsertOnboarding({
        userWorkosId: identity.user.workosUserId,
        workspaceId: context.workspace.id,
      });
      await scaffoldOnboardingBrainFolders({
        brainRef: brain.id,
        userWorkosId: identity.user.workosUserId,
      });
      await activateWorkspace({
        workspaceId: context.workspace.id,
        workosOrganizationId,
        brainId: brain.id,
      });
      revalidatePath("/", "layout");
      return { ok: true, workspaceId: context.workspace.id, brainRef: brain.id };
    }

    if (await hasOwnedHobbyWorkspace(identity.user.workosUserId)) {
      return { ok: false, error: "Your existing Hobby workspace could not be loaded." };
    }

    const created = await provisionWorkspace({
      authUserId: identity.authUser.id,
      userWorkosId: identity.user.workosUserId,
      name,
      slug,
    });
    await upsertOnboarding({
      userWorkosId: identity.user.workosUserId,
      workspaceId: created.workspace.id,
    });
    await scaffoldOnboardingBrainFolders({
      brainRef: created.brain.id,
      userWorkosId: identity.user.workosUserId,
    });
    await enrollOwnerInOnboardingEmails({
      workosUserId: identity.user.workosUserId,
    }).catch((error) => {
      console.error("[goat] Failed to enroll owner in onboarding emails", error);
    });
    await activateWorkspace({
      workspaceId: created.workspace.id,
      workosOrganizationId: created.workspace.workosOrganizationId,
      brainId: created.brain.id,
    });
    revalidatePath("/", "layout");
    return { ok: true, workspaceId: created.workspace.id, brainRef: created.brain.id };
  } catch (error) {
    unstable_rethrow(error);
    const provisioning = error instanceof WorkspaceProvisioningError ? error : null;
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

async function scaffoldOnboardingBrainFolders(input: { brainRef: string; userWorkosId: string }) {
  const onboarding = await getOnboarding(input.userWorkosId);
  const target = new Set(onboardingFoldersForRole(onboarding?.role));
  const adjustable = new Set<string>(ADJUSTABLE_DEFAULT_BRAIN_FOLDERS);

  // Workspace provisioning seeds the generic defaults. Reconcile them with the
  // role preset automatically so users get a useful Brain without being asked
  // to design its information architecture during onboarding.
  for (const folder of ADJUSTABLE_DEFAULT_BRAIN_FOLDERS) {
    if (target.has(folder)) {
      await createBrainFolderForUser({ ...input, folderPath: folder });
    } else {
      await deleteBrainFolderForUser({ ...input, folderPath: folder });
    }
  }
  for (const folder of target) {
    if (adjustable.has(folder)) continue;
    await createBrainFolderForUser({ ...input, folderPath: folder });
  }
}

export async function saveOnboardingProfileAction(input: {
  role: string | null;
  companyUrl: string;
}): Promise<OnboardingActionResult> {
  const identity = await currentIdentity();
  const context = await currentUser({ optional: true });
  const profile = parseOnboardingProfile(input);
  if (!profile.ok) return profile;
  try {
    await upsertOnboarding({
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

export async function finishOnboardingAction(input: {
  referralSource: string | null;
}): Promise<OnboardingActionResult> {
  const context = await currentUser();
  try {
    await upsertOnboarding({
      userWorkosId: context.user.workosUserId,
      workspaceId: context.workspace.id,
      referralSource: input.referralSource?.trim() || null,
    });
    await markUserOnboarded(context.user.workosUserId);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not finish onboarding.");
  }
}
