import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MainPanel from "@/components/MainPanel";
import { createAgentSessionFromPrompt } from "@/lib/agent-sessions/actions";

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => false,
}));

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/components/CollectionsProvider", () => ({
  useCollections: () => ({ agents: {} }),
}));

vi.mock("@/components/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({ workspaceId: "wks_test" }),
}));

vi.mock("@/components/ToastProvider", () => ({
  useToast: () => ({ showToast: vi.fn(), showError: vi.fn() }),
}));

vi.mock("@/components/useComposerAttachments", () => ({
  useComposerAttachments: () => ({
    attachments: [],
    setAttachments: vi.fn(),
    acceptFiles: vi.fn(),
    removeAttachment: vi.fn(),
    isDragActive: false,
    isUploading: false,
    handlePasteFiles: vi.fn(),
    dragHandlers: {},
  }),
}));

vi.mock("@/components/agent-editor/ModelPicker", () => ({
  ModelPicker: ({ value }: { value: string }) => (
    <button type="button" aria-label="Model">
      {value}
    </button>
  ),
}));

vi.mock("@/lib/agent-sessions/actions", () => ({
  createAgentSessionFromPrompt: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/payload", () => ({
  seedSessionQueries: vi.fn(),
}));

const createAgentSessionFromPromptMock = vi.mocked(createAgentSessionFromPrompt);

const agents: ComponentProps<typeof MainPanel>["agents"] = [
  {
    id: "agt_codex",
    name: "Codex",
    defaultModel: "codex/gpt-5.1-codex-max",
    engine: "codex",
  },
  {
    id: "agt_opencompany",
    name: "OpenCompany",
    defaultModel: "openai/gpt-5.4-mini",
    engine: "opencompany",
  },
];

function renderMainPanel(inputAgents = agents) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MainPanel agents={inputAgents} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  createAgentSessionFromPromptMock.mockReset();
  routerMock.push.mockReset();
});

describe("MainPanel Codex controls", () => {
  it("submits initial Codex sessions with reasoning and one-shot plan mode", async () => {
    const user = userEvent.setup();
    createAgentSessionFromPromptMock.mockResolvedValue({
      ok: true,
      session: { id: "sess_codex" },
      detail: {},
    } as Awaited<ReturnType<typeof createAgentSessionFromPrompt>>);

    renderMainPanel();

    const reasoningButton = screen.getByRole("button", {
      name: "Codex reasoning effort: High (click to cycle)",
    });
    await user.click(reasoningButton);
    expect(
      screen.getByRole("button", { name: "Codex reasoning effort: XHigh (click to cycle)" }),
    ).toBeInTheDocument();

    const planButton = screen.getByRole("button", { name: "Plan" });
    await user.click(planButton);
    expect(planButton).toHaveAttribute("aria-pressed", "true");

    await user.type(
      screen.getByPlaceholderText("Ask Open Company to build, fix bugs, explore"),
      "Plan the change",
    );
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(createAgentSessionFromPromptMock).toHaveBeenCalledWith(
        "agt_codex",
        "Plan the change",
        expect.any(String),
        [],
        {
          codexReasoningEffort: "xhigh",
          codexPlanModeEnabled: true,
        },
      ),
    );
    expect(routerMock.push).toHaveBeenCalledWith("/company/session/sess_codex");
    await waitFor(() => expect(planButton).toHaveAttribute("aria-pressed", "false"));
  });

  it("hides Codex controls and omits Codex options for non-Codex agents", async () => {
    const user = userEvent.setup();
    createAgentSessionFromPromptMock.mockResolvedValue({
      ok: true,
      session: { id: "sess_opencompany" },
      detail: {},
    } as Awaited<ReturnType<typeof createAgentSessionFromPrompt>>);

    renderMainPanel([agents[1]!]);

    expect(
      screen.queryByRole("button", { name: /Codex reasoning effort/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Plan" })).not.toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("Ask Open Company to build, fix bugs, explore"),
      "Ship it",
    );
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(createAgentSessionFromPromptMock).toHaveBeenCalledWith(
        "agt_opencompany",
        "Ship it",
        "openai/gpt-5.4-mini",
        [],
        undefined,
      ),
    );
  });
});
