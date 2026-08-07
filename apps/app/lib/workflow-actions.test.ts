import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveWorkflowAction,
  createWorkflowAction,
  updateWorkflowAction,
} from "@/lib/workflow-actions";

const authMock = vi.hoisted(() => ({
  currentUser: vi.fn(),
}));

const workflowMocks = vi.hoisted(() => ({
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  archiveWorkflow: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentUser: authMock.currentUser,
}));

vi.mock("@/lib/workflows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workflows")>();
  return {
    ...actual,
    createWorkflow: workflowMocks.createWorkflow,
    updateWorkflow: workflowMocks.updateWorkflow,
    archiveWorkflow: workflowMocks.archiveWorkflow,
  };
});

vi.mock("next/cache", () => ({
  revalidatePath: cacheMocks.revalidatePath,
}));

beforeEach(() => {
  vi.clearAllMocks();
  authMock.currentUser.mockResolvedValue({
    user: { workosUserId: "user_member" },
    workspace: { id: "workspace_1" },
    role: "member",
  });
  workflowMocks.createWorkflow.mockResolvedValue({ ok: true, slug: "weekly-update" });
  workflowMocks.updateWorkflow.mockResolvedValue({ ok: true, slug: "weekly-update" });
  workflowMocks.archiveWorkflow.mockResolvedValue({ ok: true, slug: "weekly-update" });
});

describe("workflow actions", () => {
  it("lets workspace members create shared workflows", async () => {
    await expect(
      createWorkflowAction({
        name: "Weekly update",
        description: "Summarize the week.",
      }),
    ).resolves.toEqual({ ok: true, slug: "weekly-update" });

    expect(workflowMocks.createWorkflow).toHaveBeenCalledWith({
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
      updateWorkflowAction({
        slug: "weekly-update",
        name: "Weekly update",
        description: "",
        steps: [step],
        status: "active",
      }),
    ).resolves.toEqual({ ok: true, slug: "weekly-update" });

    expect(workflowMocks.updateWorkflow).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      slug: "weekly-update",
      name: "Weekly update",
      description: "",
      steps: [step],
      status: "active",
      scheduleHarnessSpec: null,
      scheduleUserWorkosId: null,
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/workflows/weekly-update");
  });

  it("lets workspace members archive shared workflows", async () => {
    await expect(archiveWorkflowAction({ slug: "weekly-update" })).resolves.toEqual({
      ok: true,
      slug: "weekly-update",
    });

    expect(workflowMocks.archiveWorkflow).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      slug: "weekly-update",
    });
  });
});
