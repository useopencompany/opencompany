export const GOAT_CODEX_HOST_TOOL_CONTRACT_VERSION = "goat-codex-host-tools.v2";
export const GOAT_CODEX_LIST_ACTIONS_TOOL_NAME = "list_actions";
export const GOAT_CODEX_USE_ACTION_TOOL_NAME = "use_action";
export const GOAT_CODEX_MAX_ACTION_CALLS_PER_TURN = 16;

export type GoatCodexActionSource = {
  id: string;
  label: string;
  description: string;
};

export type GoatCodexActionDescriptor = {
  id: string;
  source: string;
  description: string;
  params: unknown;
};

export type GoatCodexActionGatewayRequest =
  | {
      operation: "list";
      codexChatSessionId: string;
      codexChatTurnId: string;
      source?: string;
    }
  | {
      operation: "execute";
      codexChatSessionId: string;
      codexChatTurnId: string;
      action: string;
      params: Record<string, unknown>;
      toolCallId: string;
    };

export type GoatCodexActionGatewayResponse =
  | {
      ok: true;
      sources: GoatCodexActionSource[];
    }
  | {
      ok: true;
      source: GoatCodexActionSource;
      actions: GoatCodexActionDescriptor[];
    }
  | {
      ok: true;
      action: string;
      result: unknown;
    }
  | {
      ok: false;
      action?: string;
      error: {
        code: string;
        source?: string;
        message: string;
      };
    };
