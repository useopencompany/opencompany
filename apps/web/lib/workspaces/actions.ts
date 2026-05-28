"use server";

import { getDb } from "@opencompany/db/client";
import { workspaces } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { AUTHENTICATION_REQUIRED_MESSAGE, currentWorkspace } from "@/lib/auth";
import { getWorkOSClient } from "@/lib/workos";

export async function updateWorkspaceName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false as const, error: "Name cannot be empty." };
  if (trimmed.length > 80) {
    return { ok: false as const, error: "Name is too long (max 80 chars)." };
  }

  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const { workspace } = context;
  if (!workspace.workosOrganizationId) {
    return {
      ok: false as const,
      error: "Workspace is not linked to an organization.",
    };
  }

  const db = getDb();

  await getWorkOSClient().organizations.updateOrganization({
    organization: workspace.workosOrganizationId,
    name: trimmed,
  });

  await db
    .update(workspaces)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));

  revalidatePath("/", "layout");
  revalidatePath("/settings");

  return { ok: true as const, name: trimmed };
}

function normalizeInviteEmail(email: string) {
  return email.trim().toLowerCase();
}

function isValidInviteEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function workosInvitationErrorMessage(error: unknown) {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const status = typeof record.status === "number" ? record.status : undefined;
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (status === 429 || code.includes("rate")) {
    return "Too many invitations were sent recently. Try again in a moment.";
  }

  if (code.includes("already") || message.includes("already") || message.includes("duplicate")) {
    return "That email has already been invited or belongs to a workspace member.";
  }

  return "Could not send the invitation. Try again in a moment.";
}

export async function inviteWorkspaceMember(email: string) {
  const normalizedEmail = normalizeInviteEmail(email);
  if (!normalizedEmail) return { ok: false as const, error: "Email cannot be empty." };
  if (!isValidInviteEmail(normalizedEmail)) {
    return { ok: false as const, error: "Enter a valid email address." };
  }

  const { authUser, workspace } = await currentWorkspace({
    requireAdmin: true,
  });
  if (!workspace.workosOrganizationId) {
    return {
      ok: false as const,
      error: "Workspace is not linked to an organization.",
    };
  }

  try {
    await getWorkOSClient().userManagement.sendInvitation({
      email: normalizedEmail,
      organizationId: workspace.workosOrganizationId,
      roleSlug: "member",
      inviterUserId: authUser.id,
    });
  } catch (error) {
    return { ok: false as const, error: workosInvitationErrorMessage(error) };
  }

  return { ok: true as const, email: normalizedEmail };
}
