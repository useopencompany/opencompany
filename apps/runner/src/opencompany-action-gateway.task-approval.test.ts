import { ACTION_EFFECTS_WRITE } from "@opencompany/agent/actions/types";
import { createActionHostGateway } from "@opencompany/agent/application/persisted-action-gateway";
import type { CodexChatEngine } from "@opencompany/db/product-schema";
import { describe, expect, it, vi } from "vitest";
import { createActionDispatcher } from "./opencompany-action-gateway";

const database = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@opencompany/db/client", () => ({ getDb: () => database }));

describe("durable task action approval", () => {
  it.each(["opencompany", "codex", "claude_code"] as const)(
    "requests approval through the persisted context for the %s engine",
    async (engine: CodexChatEngine) => {
      const query = {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn(async () => [
          {
            userWorkosId: "user_1",
            workspaceId: "workspace_1",
            chatSessionId: "conversation_1",
            userTimezone: "UTC",
            assistantMessageId: "message_1",
            chatKind: "task",
            engine,
          },
        ]),
      };
      database.select.mockReturnValue(query);
      const source = "plugin:google-drive:google-drive";
      const action = `${source}.replace_document_text`;
      const executeAction = vi.fn(async () => ({ ok: true as const, action, result: {} }));
      let status: "pending" | "approved" | "denied" = "pending";
      const registerApproval = vi.fn(async (input: { decision?: "pending" | "denied" }) => ({
        actionId: action,
        sourceId: source,
        capabilityId: "write",
        inputHash: "input_hash",
        status: input.decision ?? status,
      }));
      const gateway = createActionHostGateway({
        actionsKilled: () => false,
        resolveCatalog: async () => ({
          providers: [{ id: source, kind: "integration", label: "Google Drive", description: "" }],
          actions: [
            {
              id: action,
              provider: source,
              capability: "write",
              effects: ACTION_EFFECTS_WRITE,
              permissionMode: "ask",
              description: "Edit a document.",
              params: { type: "object" },
              execute: vi.fn(),
            },
          ],
        }),
        registerApproval,
        executeAction,
        recordSourceDiscovery: async () => {},
        claimInvocation: async () => ({ ok: true, callCount: 1, duplicate: false }),
      });
      const dispatcher = await createActionDispatcher(
        {
          sessionId: "session_1",
          turnId: "turn_1",
          signal: new AbortController().signal,
          approvalContinuation: false,
        },
        { execute: gateway },
      );
      const input = {
        action,
        params: { fileId: "document_1", findText: "Tasks", replaceText: "Tasks\nNew task" },
        toolCallId: "call_1",
      };

      await expect(dispatcher?.needsApproval?.(input)).resolves.toBe(true);
      expect(registerApproval).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ decision: "denied" }),
      );
      await expect(dispatcher?.execute(input)).resolves.toMatchObject({
        ok: false,
        error: { code: "approval_required" },
      });
      expect(executeAction).not.toHaveBeenCalled();

      status = "approved";
      await expect(dispatcher?.needsApproval?.(input)).resolves.toBe(false);
      await expect(dispatcher?.execute(input)).resolves.toMatchObject({ ok: true, action });
      expect(executeAction).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ actionId: action, params: input.params, sourceEngine: engine }),
      );

      status = "denied";
      const deniedInput = { ...input, toolCallId: "call_denied" };
      await expect(dispatcher?.needsApproval?.(deniedInput)).resolves.toBe(false);
      await expect(dispatcher?.execute(deniedInput)).resolves.toMatchObject({
        ok: false,
        error: { code: "not_permitted", message: `The user denied approval for "${action}".` },
      });
      expect(executeAction).toHaveBeenCalledOnce();
    },
  );
});
