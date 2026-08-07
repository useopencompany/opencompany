export const GOAT_CODEX_SAVE_TO_BRAIN_TOOL_NAME = "save_to_brain";

export type CodexBrainCaptureGatewayRequest = {
  codexChatSessionId: string;
  codexChatTurnId: string;
  content?: string;
  title?: string;
  intent?: string;
  sourceRef?: string;
  integrationId?: string;
  fallbackContent?: string;
};

export type CodexBrainCaptureGatewayResponse =
  | {
      ok: true;
      status: "captured" | "already_captured" | "paused_by_plan";
      message?: string;
      draftId: string;
      path: string;
      title: string;
    }
  | {
      ok: false;
      error: string;
    };
