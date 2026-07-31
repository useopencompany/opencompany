import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveGoatWorkflowAction,
  createGoatWorkflowAction,
  updateGoatWorkflowAction,
} from "@/lib/workflow-actions";

const authMock = vi.hoisted(() => ({
  currentGoatUser: vi.fn(),
}));

const workflowMocks = vi.hoisted(() => ({
  createGoatWorkflow: vi.fn(),
  updateGoatWorkflow: vi.fn(),
  archiveGoatWorkflow: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentGoatUser: authMock.currentGoatUser,
}));

vi.mock("@/lib/workflows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workflows")>();
  return {
    ...actual,
    createGoatWorkflow: workflowMocks.createGoatWorkflow,
    updateGoatWorkflow: workflowMocks.updateGoatWorkflow,
    archiveGoatWorkflow: workflowMocks.archiveGoatWorkflow,
  };
});

vi.mock("next/cache", () => ({
  revalidatePath: cacheMocks.revalidatePath,
}));

beforeEach(() => {
  vi.clearAllMocks();
  authMock.currentGoatUser.mockResolvedValue({
    user: { workosUserId: "user_member" },
    workspace: { id: "workspace_1" },
    role: "member",
  });
  workflowMocks.createGoatWorkflow.mockResolvedValue({ ok: true, slug: "weekly-update" });
  workflowMocks.updateGoatWorkflow.mockResolvedValue({ ok: true, slug: "weekly-update" });
  workflowMocks.archiveGoatWorkflow.mockResolvedValue({ ok: true, slug: "weekly-update" });
});

describe("workflow actions", () => {
  it("lets workspace members create shared workflows", async () => {
    await expect(
      createGoatWorkflowAction({
        name: "Weekly update",
        description: "Summarize the week.",
      }),
    ).resolves.toEqual({ ok: true, slug: "weekly-update" });

    expect(workflowMocks.createGoatWorkflow).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      createdByWorkosId: "user_member",
      name: "Weekly update",
      description: "Summarize the week.",
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/workflows");
  });

  it("lets workspace members edit shared workflows", async () => {
    const step = {
      id: "step-1",
      title: "Draft",
      model: "",
      instructions: "Write the update.",
    };

    await expect(
      updateGoatWorkflowAction({
        slug: "weekly-update",
        name: "Weekly update",
        description: "",
        steps: [step],
        status: "active",
      }),
    ).resolves.toEqual({ ok: true, slug: "weekly-update" });

    expect(workflowMocks.updateGoatWorkflow).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      slug: "weekly-update",
      name: "Weekly update",
      description: "",
      steps: [step],
      status: "active",
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/workflows/weekly-update");
  });

  it("lets workspace members archive shared workflows", async () => {
    await expect(archiveGoatWorkflowAction({ slug: "weekly-update" })).resolves.toEqual({
      ok: true,
      slug: "weekly-update",
    });

    expect(workflowMocks.archiveGoatWorkflow).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      slug: "weekly-update",
    });
  });
});
