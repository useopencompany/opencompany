import { PGlite } from "@electric-sql/pglite";
import { ACTION_EFFECTS_WRITE } from "@opencompany/agent/actions/types";
import type {
  ActionGatewayServiceDependencies,
  ActionServiceRunRef,
} from "@opencompany/agent/application/action-gateway";
import {
  createActionGateway,
  createActionHostGateway,
} from "@opencompany/agent/application/persisted-action-gateway";
import type { Actor } from "@opencompany/core";
import {
  claimActionInvocation,
  recordActionSourceDiscovery,
  registerActionApproval,
} from "@opencompany/db/action-governance";
import {
  PostgresChatRepository,
  PostgresRunExecutionRepository,
} from "@opencompany/db/chat-repository";
import type { CodexChatTurn } from "@opencompany/db/product-schema";
import { PostgresTaskActionApprovalRepository } from "@opencompany/db/task-action-approvals";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it, vi } from "vitest";
import { executeExternalActionWithApproval } from "./acp-tools-mcp";
import { resumeTaskActionApprovals } from "./task-action-approval";

// The provider is a fixture; gateway governance, persistence, approval resolution,
// and restart/resume all execute their production code against Postgres.
it.each(["approved", "denied"] as const)(
  "runs the complete Gmail task approval flow with %s",
  async (resolution) => {
    const pg = new PGlite();
    try {
      await pg.exec(SCHEMA);
      const dialect = new PgDialect();
      const execute = (query: SQL) => {
        const compiled = dialect.sqlToQuery(query);
        return pg.query(compiled.sql, compiled.params);
      };
      const db = drizzle(pg);
      const provider = vi.fn(async () => ({
        ok: true as const,
        action: "plugin:gmail:gmail.create_draft",
        result: { draftId: "draft_1" },
      }));
      const turnRef = (run: ActionServiceRunRef) => ({
        sessionId: run.sessionId,
        turnId: run.runId,
        userWorkosId: run.actorId,
        workspaceId: run.workspaceId,
        policy: run.policy,
      });
      const dependencies: Partial<ActionGatewayServiceDependencies> = {
        loadContext: async () => ({
          actorId: "user_1",
          workspaceId: "workspace_1",
          conversationId: "chat_1",
          userTimezone: "UTC",
          engine: "codex",
          policy: "headless",
          durableTaskApprovals: true,
        }),
        resolveCatalog: async () => ({
          providers: [
            { id: "plugin:gmail:gmail", kind: "integration", label: "Gmail", description: "Gmail" },
          ],
          actions: [
            {
              id: "plugin:gmail:gmail.create_draft",
              provider: "plugin:gmail:gmail",
              capability: "write",
              effects: ACTION_EFFECTS_WRITE,
              permissionMode: "ask",
              description: "Create draft",
              params: { type: "object" },
              execute: provider,
            },
          ],
        }),
        executeAction: provider,
        registerApproval: ({ run, ...input }) =>
          registerActionApproval({ ...input, turn: turnRef(run), db }),
        recordSourceDiscovery: ({ run, sourceId }) =>
          recordActionSourceDiscovery({ turn: turnRef(run), sourceId, db }),
        claimInvocation: ({ run, ...input }) =>
          claimActionInvocation({ ...input, turn: turnRef(run), db }),
      };
      const gateway = createActionGateway(dependencies);
      const host = createActionHostGateway(dependencies);
      const actions = new PostgresTaskActionApprovalRepository(execute);
      const signal = new AbortController().signal;
      await gateway({
        request: {
          operation: "list",
          sessionId: "runtime_1",
          turnId: "run_1",
          source: "plugin:gmail:gmail",
        },
        signal,
      });
      const params = {
        to: "recipient@example.com",
        subject: "Ready",
        body: "The feature is live.",
      };
      const context = {
        taskConversation: true,
        skillToolsEnabled: false,
        actorId: "user_1",
        workspaceId: "workspace_1",
        workspaceName: "Test",
        workspaceSlug: null,
        legacyBrainEnabled: false,
        conversationId: "chat_1",
        sandboxId: "sandbox_1",
        engine: "codex" as const,
        brainRef: null,
        userMessageId: "user_message",
        assistantMessageId: "assistant_1",
        hostToolContractVersion: "goat-codex-host-tools.v3",
      };
      const call = (requestId: string) =>
        executeExternalActionWithApproval({
          request: {
            operation: "execute",
            sessionId: "runtime_1",
            turnId: "run_1",
            invocationId: requestId,
            action: "plugin:gmail:gmail.create_draft",
            params,
          },
          signal,
          capability: {
            v: 2,
            codexChatSessionId: "runtime_1",
            codexChatTurnId: "run_1",
            attemptId: "attempt_1",
            leaseId: "lease_1",
            expiresAt: Date.now() + 60_000,
          },
          authorizedContext: context,
          authorizeOperation: async () => context,
          dependencies: {
            executeAction: gateway,
            evaluateApproval: host,
            taskActions: actions,
            requestApproval: vi.fn(),
            waitForApproval: vi.fn(),
            resolveApproval: vi.fn(),
          },
        });
      expect(await call("mcp_1")).toMatchObject({
        ok: false,
        error: { code: "approval_required" },
      });
      expect(provider).not.toHaveBeenCalled();
      const [saved] = await actions.requests("run_1");
      if (!saved) throw new Error("Expected a saved request");
      await new PostgresRunExecutionRepository(execute).pauseForApprovals({
        worker: { workerId: "worker_1" },
        runId: "run_1",
        attemptId: "attempt_1",
        leaseId: "lease_1",
        approvals: [
          {
            id: "approval_1",
            toolCallId: saved.invocationId,
            kind: "use_action",
            action: saved.action,
            prompt: "Create draft?",
            input: { action: saved.action, params: saved.params },
          },
        ],
        settledMessageParts: [],
      });
      const api = new PostgresChatRepository(execute);
      const actor = { userId: "user_1", workspaceId: "workspace_1" } as Actor;
      await api.resolveApproval({
        actor,
        command: { runId: "run_1", approvalId: "approval_1", resolution },
      });
      expect(
        (
          await api.resolveApproval({
            actor,
            command: { runId: "run_1", approvalId: "approval_1", resolution },
          })
        )?.idempotentReplay,
      ).toBe(true);
      await pg.exec(
        "UPDATE goat.codex_chat_turns SET status='running', lease_id='lease_2' WHERE id='run_1'",
      );
      const turn = {
        id: "run_1",
        codexChatSessionId: "runtime_1",
        leaseId: "lease_2",
      } as CodexChatTurn;
      const resumed = await resumeTaskActionApprovals(turn, {
        repository: new PostgresTaskActionApprovalRepository(execute),
        execute: gateway,
      });
      expect(resumed).toContain(resolution === "approved" ? "draft_1" : "The user denied");
      expect(provider).toHaveBeenCalledTimes(resolution === "approved" ? 1 : 0);
      if (resolution === "approved")
        expect(provider).toHaveBeenCalledWith(expect.objectContaining({ params }));
      await resumeTaskActionApprovals(turn, {
        repository: new PostgresTaskActionApprovalRepository(execute),
        execute: gateway,
      });
      const retry = await call("new_mcp_id_after_restart");
      expect(retry.ok).toBe(resolution === "approved");
      expect(provider).toHaveBeenCalledTimes(resolution === "approved" ? 1 : 0);
      expect((await pg.query("SELECT status FROM goat.tasks WHERE id='task_1'")).rows).toEqual([
        { status: "queued" },
      ]);
    } finally {
      await pg.close();
    }
  },
  30_000,
);

const SCHEMA = `
CREATE SCHEMA goat;
CREATE TABLE goat.chat_sessions (id text PRIMARY KEY, kind text, closed_at timestamptz, has_unseen boolean DEFAULT false, updated_at timestamptz);
CREATE TABLE goat.codex_chat_sessions (id text PRIMARY KEY, workspace_id text, chat_session_id text, status text, active_turn_id text, error text, updated_at timestamptz);
CREATE TABLE goat.codex_chat_turns (id text PRIMARY KEY, user_workos_id text, chat_session_id text, codex_chat_session_id text, assistant_message_id text,
  status text, settings jsonb DEFAULT '{}', lease_id text, lease_owner text, lease_expires_at timestamptz, interrupt_requested_at timestamptz,
  event_sequence integer DEFAULT 0, updated_at timestamptz);
CREATE TABLE goat.run_attempts (id text PRIMARY KEY, run_id text, status text, lease_id text, worker_id text, completed_at timestamptz);
CREATE TABLE goat.run_approvals (id text PRIMARY KEY, run_id text, attempt_id text, tool_call_id text, kind text, prompt text, options jsonb, status text,
  resolution text, response jsonb, resolved_at timestamptz, created_at timestamptz, updated_at timestamptz);
CREATE TABLE goat.run_events (id text PRIMARY KEY, run_id text, attempt_id text, sequence integer, schema_version integer, type text, payload jsonb, created_at timestamptz, UNIQUE(run_id,sequence));
CREATE TABLE goat.tasks (id text PRIMARY KEY, session_id text, user_workos_id text, workspace_id text, status text, stage text, reported_outcome text, outcome_comment text, updated_at timestamptz, archived_at timestamptz);
CREATE TABLE goat.chat_messages (id text PRIMARY KEY, role text, debug_trace jsonb, updated_at timestamptz);
CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text);
CREATE TABLE goat.capability_runs (id text PRIMARY KEY, tool_call_id text, chat_session_id text, user_workos_id text, workspace_id text, status text, approved_at timestamptz, approval_expires_at timestamptz, updated_at timestamptz);
CREATE TABLE goat.action_turns (id text PRIMARY KEY, session_id text, turn_id text, user_workos_id text, workspace_id text, policy text,
  action_call_count integer DEFAULT 0, invocation_ids jsonb DEFAULT '[]', listed_source_ids jsonb DEFAULT '[]', quoted_total_usd_micros bigint DEFAULT 0,
  admitted_invocation_ids jsonb DEFAULT '[]', capability_quotes jsonb DEFAULT '{}', approval_records jsonb DEFAULT '{}', async_runs_started integer DEFAULT 0,
  async_invocation_ids jsonb DEFAULT '[]', expires_at timestamptz, created_at timestamptz, updated_at timestamptz, UNIQUE(session_id,turn_id));
INSERT INTO goat.chat_sessions(id,kind) VALUES ('chat_1','task');
INSERT INTO goat.codex_chat_sessions(id,workspace_id,chat_session_id,status,active_turn_id) VALUES ('runtime_1','workspace_1','chat_1','running','run_1');
INSERT INTO goat.codex_chat_turns(id,user_workos_id,chat_session_id,codex_chat_session_id,assistant_message_id,status,lease_id,lease_owner)
 VALUES ('run_1','user_1','chat_1','runtime_1','assistant_1','running','lease_1','worker_1');
INSERT INTO goat.run_attempts(id,run_id,status,lease_id,worker_id) VALUES ('attempt_1','run_1','running','lease_1','worker_1');
INSERT INTO goat.tasks(id,session_id,user_workos_id,workspace_id,status) VALUES ('task_1','chat_1','user_1','workspace_1','running');
INSERT INTO goat.chat_messages(id,role) VALUES ('assistant_1','assistant');
INSERT INTO goat.workspace_members VALUES ('workspace_1','user_1');
`;
