import { NextResponse } from "next/server";
import { loadAgentSessionPreviewTargetForWorkspace } from "@/lib/agent-sessions/data";
import {
  type SessionPreviewPayload,
  type SessionPreviewUnavailableReason,
} from "@/lib/agent-sessions/payload";
import { callRunnerJson, getRunnerPublicUrl } from "@/lib/agent-sessions/runner";
import { currentWorkspace } from "@/lib/auth";

const SESSION_PREVIEW_API_HEADERS = { "Cache-Control": "private, no-store" } as const;

type RunnerPreviewResponse = {
  preview: SessionPreviewPayload;
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, workspace } = await currentWorkspace();
  const session = await loadAgentSessionPreviewTargetForWorkspace(id, user.id, workspace.id);

  if (!session) {
    return NextResponse.json(
      { error: "Session not found." },
      { status: 404, headers: SESSION_PREVIEW_API_HEADERS },
    );
  }

  if (session.engine !== "codex") {
    return previewResponse(unavailable("not_codex", "Preview URLs are only available for Codex."));
  }

  if (!session.e2bSandboxId) {
    return previewResponse(
      unavailable("no_sandbox", "No active sandbox has been attached to this session yet."),
    );
  }

  if (!getRunnerPublicUrl() || !process.env.RUNNER_INTERNAL_TOKEN) {
    return previewResponse(
      unavailable(
        "runner_unconfigured",
        "Runner is not configured, so the sandbox preview URL cannot be detected.",
      ),
    );
  }

  try {
    const result = await callRunnerJson<RunnerPreviewResponse>(
      `/internal/sessions/${encodeURIComponent(id)}/preview-url`,
      {
        body: { workspaceId: workspace.id },
        context: {
          workspace_id: workspace.id,
          session_id: id,
          engine: "codex",
          event: "opencompany.session_preview_url_detect",
        },
      },
    );
    return previewResponse(result.preview);
  } catch {
    return previewResponse(
      unavailable(
        "runner_error",
        "Could not detect the sandbox preview URL. Try again once the dev server is running.",
      ),
    );
  }
}

function previewResponse(preview: SessionPreviewPayload) {
  return NextResponse.json({ preview }, { headers: SESSION_PREVIEW_API_HEADERS });
}

function unavailable(
  reason: SessionPreviewUnavailableReason,
  message: string,
): SessionPreviewPayload {
  return { available: false, reason, message };
}
