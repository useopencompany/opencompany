import type { Actor } from "@opencompany/core";
import {
  getGoatCapabilityApproval,
  getGoatCapabilityApprovalByToolCall,
  getGoatCapabilitySessionBudgetUsdMicros,
  listGoatWorkspaceCapabilities,
  setGoatCapabilitySessionBudget,
  setGoatWorkspaceCapability,
} from "@opencompany/db/goat-capabilities";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceCapabilityService } from "./workspace-capabilities";

vi.mock("@opencompany/db/goat-capabilities", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGoatCapabilityApproval: vi.fn(),
  getGoatCapabilityApprovalByToolCall: vi.fn(),
  getGoatCapabilitySessionBudgetUsdMicros: vi.fn(async () => 5_000_000),
  listGoatWorkspaceCapabilities: vi.fn(async () => [{ source: "x", enabled: true }]),
  setGoatCapabilitySessionBudget: vi.fn(async () => 2_500_000),
  setGoatWorkspaceCapability: vi.fn(async (input) => ({
    source: input.source,
    enabled: input.enabled,
  })),
}));

const admin: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: [],
  authenticationMethod: "session",
};
const member: Actor = { ...admin, role: "member" };
const db = { sentinel: true } as never;

describe("workspace capability service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads capability settings through the injected database handle", async () => {
    const service = createWorkspaceCapabilityService({ db });
    await expect(service.getSettings(member)).resolves.toEqual({
      capabilities: [{ source: "x", enabled: true }],
      sessionBudgetUsdMicros: 5_000_000,
    });
    expect(listGoatWorkspaceCapabilities).toHaveBeenCalledWith("workspace_1", db);
    expect(getGoatCapabilitySessionBudgetUsdMicros).toHaveBeenCalledWith("workspace_1", db);
  });

  it("requires workspace-admin authorization for toggles and budgets", async () => {
    const service = createWorkspaceCapabilityService({ db });
    await expect(service.setCapability(member, "x", false)).rejects.toMatchObject({
      status: 403,
      message: "Only workspace admins can change paid capabilities.",
    });
    await expect(service.setSessionBudget(member, 2.5)).rejects.toMatchObject({ status: 403 });
    expect(setGoatWorkspaceCapability).not.toHaveBeenCalled();
    expect(setGoatCapabilitySessionBudget).not.toHaveBeenCalled();
  });

  it("stores the admin's identity and normalizes dollars to integer micros", async () => {
    const service = createWorkspaceCapabilityService({ db });
    await expect(service.setCapability(admin, "linkedin", false)).resolves.toEqual({
      source: "linkedin",
      enabled: false,
    });
    expect(setGoatWorkspaceCapability).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      source: "linkedin",
      enabled: false,
      updatedByWorkosId: "user_1",
      db,
    });
    await expect(service.setSessionBudget(admin, 2.5)).resolves.toBe(2_500_000);
    expect(setGoatCapabilitySessionBudget).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      budgetUsdMicros: 2_500_000,
      db,
    });
  });

  it("scopes approval reads to both actor and workspace", async () => {
    vi.mocked(getGoatCapabilityApproval).mockResolvedValueOnce(approvalRow() as never);
    vi.mocked(getGoatCapabilityApprovalByToolCall).mockResolvedValueOnce(approvalRow() as never);
    const service = createWorkspaceCapabilityService({ db });

    await expect(service.getApproval(member, "gcr_1")).resolves.toMatchObject({
      runId: "gcr_1",
      action: "lead.find_person_email",
    });
    expect(getGoatCapabilityApproval).toHaveBeenCalledWith({
      id: "gcr_1",
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      db,
    });
    await expect(service.getApprovalByToolCall(member, "tool_1")).resolves.toMatchObject({
      sessionBudgetUsdMicros: 5_000_000,
    });
    expect(getGoatCapabilityApprovalByToolCall).toHaveBeenCalledWith({
      toolCallId: "tool_1",
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      db,
    });
  });
});

function approvalRow() {
  return {
    id: "gcr_1",
    source: "lead" as const,
    action: "lead.find_person_email",
    status: "awaiting_approval" as const,
    quoteTotalCostUsdMicros: 360_000,
    approvalExpiresAt: new Date("2026-08-13T16:00:00.000Z"),
    totalCostUsdMicros: null,
  };
}
