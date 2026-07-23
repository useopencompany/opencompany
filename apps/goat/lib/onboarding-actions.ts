"use server";

import {
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
import { currentGoatUser } from "@/lib/auth";
import { createGoatBrainFolderForUser, deleteGoatBrainFolderForUser } from "@/lib/brain";
import { verifyGoatOnboardingCompanyUrl } from "@/lib/onboarding-company-url.server";
import {
  normalizeGoatOnboardingCompanyUrl,
  parseGoatOnboardingProfile,
} from "@/lib/onboarding-profile";
import { getWorkOSClient } from "@/lib/workos-client";

export type GoatOnboardingActionResult = { ok: true } | { ok: false; error: string };

function errorResult(error: unknown, fallback: string): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

// Mirrors the client-side slugify so what the user previews is what we store.
function normalizeGoatWorkspaceSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export async function checkGoatWorkspaceSlugAction(
  rawSlug: string,
): Promise<{ slug: string; available: boolean }> {
  const context = await currentGoatUser();
  const slug = normalizeGoatWorkspaceSlug(rawSlug);
  if (!slug) return { slug, available: false };
  const available = await isGoatWorkspaceSlugAvailable({
    slug,
    excludeWorkspaceId: context.workspace.id,
  });
  return { slug, available };
}

export async function checkGoatOnboardingCompanyUrlAction(rawUrl: string): Promise<{
  companyUrl: string | null;
  reachable: boolean;
  error: string | null;
}> {
  await currentGoatUser();
  const companyUrl = normalizeGoatOnboardingCompanyUrl(rawUrl);
  if (!companyUrl) {
    return { companyUrl: null, reachable: false, error: "Enter a valid company URL." };
  }

  const verification = await verifyGoatOnboardingCompanyUrl(companyUrl);
  return verification.ok
    ? { companyUrl, reachable: true, error: null }
    : { companyUrl, reachable: false, error: verification.error };
}

export async function saveGoatOnboardingWorkspaceAction(input: {
  name: string;
  slug: string;
}): Promise<GoatOnboardingActionResult> {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can set this up." };
  }

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Enter a company name." };
  if (name.length > 80) return { ok: false, error: "Name is too long (max 80 chars)." };

  const slug = normalizeGoatWorkspaceSlug(input.slug);
  if (!slug) return { ok: false, error: "Enter a valid workspace URL." };

  try {
    const available = await isGoatWorkspaceSlugAvailable({
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
    await updateGoatWorkspaceNameAndSlug({ workspaceId: context.workspace.id, name, slug });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return errorResult(error, "Could not save your workspace.");
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
  const context = await currentGoatUser();
  const profile = parseGoatOnboardingProfile(input);
  if (!profile.ok) return profile;
  const verification = await verifyGoatOnboardingCompanyUrl(profile.companyUrl);
  if (!verification.ok) return verification;
  try {
    await upsertGoatOnboarding({
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
