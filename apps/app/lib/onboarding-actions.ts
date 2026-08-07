"use server";

import {
  ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS,
  HARD_DEFAULT_GOAT_BRAIN_FOLDERS,
  normalizeBrainFolder,
} from "@opencompany/brain/schema";
import {
  isWorkspaceSlugAvailable,
  markUserOnboarded,
  updateWorkspaceNameAndSlug,
  upsertOnboarding,
} from "@opencompany/db/workspaces";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { createBrainFolderForUser, deleteBrainFolderForUser } from "@/lib/brain";
import { parseOnboardingProfile } from "@/lib/onboarding-profile";
import { getWorkOSClient } from "@/lib/workos-client";

export type OnboardingActionResult = { ok: true } | { ok: false; error: string };

function errorResult(error: unknown, fallback: string): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

// Mirrors the client-side slugify so what the user previews is what we store.
function normalizeWorkspaceSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export async function checkWorkspaceSlugAction(
  rawSlug: string,
): Promise<{ slug: string; available: boolean }> {
  const context = await currentUser();
  const slug = normalizeWorkspaceSlug(rawSlug);
  if (!slug) return { slug, available: false };
  const available = await isWorkspaceSlugAvailable({
    slug,
    excludeWorkspaceId: context.workspace.id,
  });
  return { slug, available };
}

export async function saveOnboardingWorkspaceAction(input: {
  name: string;
  slug: string;
}): Promise<OnboardingActionResult> {
  const context = await currentUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can set this up." };
  }

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Enter a company name." };
  if (name.length > 80) return { ok: false, error: "Name is too long (max 80 chars)." };

  const slug = normalizeWorkspaceSlug(input.slug);
  if (!slug) return { ok: false, error: "Enter a valid workspace URL." };

  try {
    const available = await isWorkspaceSlugAvailable({
      slug,
      excludeWorkspaceId: context.workspace.id,
    });
    if (!available) return { ok: false, error: "That workspace URL is taken." };

    if (context.workspace.workosOrganizationId) {
      await getWorkOSClient().organizations.updateOrganization({
        organization: context.workspace.workosOrganizationId,
        name,
      });
    }
    await updateWorkspaceNameAndSlug({ workspaceId: context.workspace.id, name, slug });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not save your workspace.");
  }
}

export async function saveOnboardingBrainFoldersAction(input: {
  folders: string[];
}): Promise<OnboardingActionResult> {
  const context = await currentUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can set this up." };
  }
  const brain = context.activeBrain;
  if (!brain) return { ok: false, error: "No brain to configure." };

  const target = new Set(
    input.folders.map((f) => normalizeBrainFolder(f)).filter((f) => f.length > 0),
  );
  const hard = new Set<string>(HARD_DEFAULT_GOAT_BRAIN_FOLDERS);
  const adjustable = new Set<string>(ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS);
  const userWorkosId = context.user.workosUserId;

  // Reconcile the seeded adjustable defaults with what the user kept, then add
  // any custom folders. Mutations are idempotent, so we ignore no-op failures.
  for (const folder of ADJUSTABLE_DEFAULT_GOAT_BRAIN_FOLDERS) {
    if (target.has(folder)) {
      await createBrainFolderForUser({ brainRef: brain.id, userWorkosId, folderPath: folder });
    } else {
      await deleteBrainFolderForUser({ brainRef: brain.id, userWorkosId, folderPath: folder });
    }
  }
  for (const folder of target) {
    if (hard.has(folder) || adjustable.has(folder)) continue;
    await createBrainFolderForUser({ brainRef: brain.id, userWorkosId, folderPath: folder });
  }

  revalidatePath("/", "layout");
  return { ok: true };
}

export async function saveOnboardingProfileAction(input: {
  role: string | null;
  companyUrl: string;
}): Promise<OnboardingActionResult> {
  const context = await currentUser();
  const profile = parseOnboardingProfile(input);
  if (!profile.ok) return profile;
  try {
    await upsertOnboarding({
      userWorkosId: context.user.workosUserId,
      workspaceId: context.workspace.id,
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
