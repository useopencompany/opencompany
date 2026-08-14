import type { Actor } from "@opencompany/core";
import {
  getCapabilityApproval,
  getCapabilityApprovalByToolCall,
  getCapabilitySessionBudgetUsdMicros,
  listWorkspaceCapabilities,
  setCapabilitySessionBudget,
  setWorkspaceCapability,
} from "@opencompany/db/capabilities";
import type { CapabilityRunStatus, ManagedCapabilitySource } from "@opencompany/db/product-schema";
import { ApiError } from "./errors";

// Follows the repo-wide injectable-db convention for services that only need a
// drizzle handle without dragging the full inferred schema type across packages.
type DbLike = any;

export type WorkspaceCapabilitySettings = {
  capabilities: Array<{ source: ManagedCapabilitySource; enabled: boolean }>;
  sessionBudgetUsdMicros: number;
};

export type CapabilityApprovalView = {
  runId: string;
  source: ManagedCapabilitySource;
  action: string;
  status: CapabilityRunStatus;
  maxCostUsdMicros: number;
  expiresAt: Date | null;
  settledCostUsdMicros: number | null;
  sessionBudgetUsdMicros?: number;
};

export type WorkspaceCapabilityService = {
  getSettings(actor: Actor): Promise<WorkspaceCapabilitySettings>;
  setCapability(
    actor: Actor,
    source: ManagedCapabilitySource,
    enabled: boolean,
  ): Promise<{ source: ManagedCapabilitySource; enabled: boolean }>;
  setSessionBudget(actor: Actor, budgetUsd: number | null): Promise<number>;
  getApproval(actor: Actor, runId: string): Promise<CapabilityApprovalView>;
  getApprovalByToolCall(actor: Actor, toolCallId: string): Promise<CapabilityApprovalView>;
};

export function createWorkspaceCapabilityService(input: {
  db: DbLike;
}): WorkspaceCapabilityService {
  const db = input.db;
  return {
    async getSettings(actor) {
      const [capabilities, sessionBudgetUsdMicros] = await Promise.all([
        listWorkspaceCapabilities(actor.workspaceId, db),
        getCapabilitySessionBudgetUsdMicros(actor.workspaceId, db),
      ]);
      return { capabilities, sessionBudgetUsdMicros };
    },

    async setCapability(actor, source, enabled) {
      requireAdmin(actor, "Only workspace admins can change paid capabilities.");
      const row = await setWorkspaceCapability({
        workspaceId: actor.workspaceId,
        source,
        enabled,
        updatedByWorkosId: actor.userId,
        db,
      });
      return { source: row.source, enabled: row.enabled };
    },

    async setSessionBudget(actor, budgetUsd) {
      requireAdmin(actor, "Only workspace admins can change the per-chat spending limit.");
      if (
        budgetUsd !== null &&
        (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 1_000)
      ) {
        throw new ApiError(
          400,
          "invalid_request",
          "Enter a spending limit between $0.01 and $1,000.",
        );
      }
      const budgetUsdMicros =
        budgetUsd === null ? null : Math.max(1, Math.round(budgetUsd * 1_000_000));
      return setCapabilitySessionBudget({
        workspaceId: actor.workspaceId,
        budgetUsdMicros,
        db,
      });
    },

    async getApproval(actor, runId) {
      const row = await getCapabilityApproval({
        id: runId,
        userWorkosId: actor.userId,
        workspaceId: actor.workspaceId,
        db,
      });
      if (!row) throw new ApiError(404, "not_found", "Approval not found");
      return approvalView(row);
    },

    async getApprovalByToolCall(actor, toolCallId) {
      const [row, sessionBudgetUsdMicros] = await Promise.all([
        getCapabilityApprovalByToolCall({
          toolCallId,
          userWorkosId: actor.userId,
          workspaceId: actor.workspaceId,
          db,
        }),
        getCapabilitySessionBudgetUsdMicros(actor.workspaceId, db),
      ]);
      if (!row) throw new ApiError(404, "not_found", "Approval not found");
      return { ...approvalView(row), sessionBudgetUsdMicros };
    },
  };
}

function requireAdmin(actor: Actor, message: string) {
  if (actor.role !== "admin") throw new ApiError(403, "forbidden", message);
}

function approvalView(row: {
  id: string;
  source: ManagedCapabilitySource;
  action: string;
  status: CapabilityRunStatus;
  quoteTotalCostUsdMicros: number;
  approvalExpiresAt: Date | null;
  totalCostUsdMicros: number | null;
}): CapabilityApprovalView {
  return {
    runId: row.id,
    source: row.source,
    action: row.action,
    status: row.status,
    maxCostUsdMicros: row.quoteTotalCostUsdMicros,
    expiresAt: row.approvalExpiresAt,
    settledCostUsdMicros: row.totalCostUsdMicros,
  };
}
