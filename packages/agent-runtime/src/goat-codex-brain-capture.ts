export const GOAT_CODEX_SAVE_TO_BRAIN_TOOL_NAME = "save_to_brain";

export type GoatCodexBrainCaptureGatewayRequest = {
  codexChatSessionId: string;
  codexChatTurnId: string;
  content?: string;
  title?: string;
  intent?: string;
  sourceRef?: string;
  integrationId?: string;
  fallbackContent?: string;
  attachmentIds?: string[];
};

export type GoatCodexBrainCaptureGatewayResponse =
  | {
      ok: true;
      status: "captured" | "already_captured" | "paused_by_plan";
      message?: string;
      draftId?: string;
      path?: string;
      title?: string;
      assets?: Array<{ documentId: string; path: string; title: string }>;
    }
  | {
      ok: false;
      error: string;
    };
