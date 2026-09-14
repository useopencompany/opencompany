"use server";

import { isSandboxSize, type SandboxSize } from "@opencompany/core/sandbox-sizes";
import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

const LOAD_ERROR_MESSAGE = "Could not load the sandbox size.";
const SAVE_ERROR_MESSAGE = "Could not update the sandbox size.";

// Read failures stay inside the card instead of throwing the whole Inference page:
// the model-subscription sections on it do not depend on this setting.
export type WorkspaceSandboxSizeResult =
  | { ok: true; sandboxSize: SandboxSize }
  | { ok: false; error: string };

export async function getWorkspaceSandboxSizeAction(): Promise<WorkspaceSandboxSizeResult> {
  try {
    const response = await (await serverApiClient()).v1.workspace["sandbox-size"].$get();
    if (!response.ok) {
      return { ok: false, error: await serverApiErrorMessage(response, LOAD_ERROR_MESSAGE) };
    }
    return { ok: true, sandboxSize: (await response.json()).data.sandboxSize };
  } catch (error) {
    console.error("[opencompany] Failed to load the workspace sandbox size", error);
    return { ok: false, error: LOAD_ERROR_MESSAGE };
  }
}

export async function setWorkspaceSandboxSizeAction(
  sandboxSize: unknown,
): Promise<WorkspaceSandboxSizeResult> {
  if (!isSandboxSize(sandboxSize)) return { ok: false, error: "Unknown sandbox size." };
  try {
    const response = await (await serverApiClient()).v1.workspace["sandbox-size"].$put({
      json: { sandboxSize },
    });
    if (!response.ok) {
      return { ok: false, error: await serverApiErrorMessage(response, SAVE_ERROR_MESSAGE) };
    }
    revalidatePath("/settings/workspace/inference");
    return { ok: true, sandboxSize: (await response.json()).data.sandboxSize };
  } catch (error) {
    console.error("[opencompany] Failed to update the workspace sandbox size", error);
    return { ok: false, error: SAVE_ERROR_MESSAGE };
  }
}
