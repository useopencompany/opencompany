import type { Actor } from "@opencompany/core";
import {
  getCapabilityApproval,
  getCapabilityApprovalByToolCall,
  getCapabilitySessionBudgetUsdMicros,
  listWorkspaceCapabilities,
  setCapabilitySessionBudget,
  setWorkspaceCapability,
} from "@opencompany/db/capabilities";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceCapabilityService } from "./workspace-capabilities";

vi.mock("@opencompany/db/capabilities", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCapabilityApproval: vi.fn(),
  getCapabilityApprovalByToolCall: vi.fn(),
  getCapabilitySessionBudgetUsdMicros: vi.fn(async () => 5_000_000),
  listWorkspaceCapabilities: vi.fn(async () => [{ source: "x", enabled: true }]),
  setCapabilitySessionBudget: vi.fn(async () => 2_500_000),
  setWorkspaceCapability: vi.fn(async (input) => ({
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
    expect(listWorkspaceCapabilities).toHaveBeenCalledWith("workspace_1", db);
    expect(getCapabilitySessionBudgetUsdMicros).toHaveBeenCalledWith("workspace_1", db);
  });

  it("requires workspace-admin authorization for toggles and budgets", async () => {
    const service = createWorkspaceCapabilityService({ db });
    await expect(service.setCapability(member, "x", false)).rejects.toMatchObject({
      status: 403,
      message: "Only workspace admins can change paid capabilities.",
    });
    await expect(service.setSessionBudget(member, 2.5)).rejects.toMatchObject({ status: 403 });
    expect(setWorkspaceCapability).not.toHaveBeenCalled();
    expect(setCapabilitySessionBudget).not.toHaveBeenCalled();
  });

  it("stores the admin's identity and normalizes dollars to integer micros", async () => {
    const service = createWorkspaceCapabilityService({ db });
    await expect(service.setCapability(admin, "linkedin", false)).resolves.toEqual({
      source: "linkedin",
      enabled: false,
    });
    expect(setWorkspaceCapability).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      source: "linkedin",
      enabled: false,
      updatedByWorkosId: "user_1",
      db,
    });
    await expect(service.setSessionBudget(admin, 2.5)).resolves.toBe(2_500_000);
    expect(setCapabilitySessionBudget).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      budgetUsdMicros: 2_500_000,
      db,
    });
  });

  it("scopes approval reads to both actor and workspace", async () => {
    vi.mocked(getCapabilityApproval).mockResolvedValueOnce(approvalRow() as never);
    vi.mocked(getCapabilityApprovalByToolCall).mockResolvedValueOnce(approvalRow() as never);
    const service = createWorkspaceCapabilityService({ db });

    await expect(service.getApproval(member, "gcr_1")).resolves.toMatchObject({
      runId: "gcr_1",
      action: "lead.find_person_email",
    });
    expect(getCapabilityApproval).toHaveBeenCalledWith({
      id: "gcr_1",
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      db,
    });
    await expect(service.getApprovalByToolCall(member, "tool_1")).resolves.toMatchObject({
      sessionBudgetUsdMicros: 5_000_000,
    });
    expect(getCapabilityApprovalByToolCall).toHaveBeenCalledWith({
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
