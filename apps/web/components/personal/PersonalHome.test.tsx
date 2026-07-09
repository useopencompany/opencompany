import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PersonalHome from "@/components/personal/PersonalHome";
import {
  PERSONAL_COMPOSER_FOCUS_EVENT,
  PERSONAL_COMPOSER_FOCUS_STORAGE_KEY,
} from "@/lib/personal/composer-shortcut";

const mocks = vi.hoisted(() => ({
  usePersonalAgent: vi.fn(() => ({
    agent: {
      id: "agt_personal",
      name: "Sofia",
      defaultModel: "moonshotai/kimi-k2.6",
    },
    userName: "Lou",
  })),
  useWorkspaceContext: vi.fn(() => ({ workspaceId: "wks_test" })),
  useQueryClient: vi.fn(() => ({})),
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  useToast: vi.fn(() => ({ showToast: vi.fn() })),
}));

vi.mock("@/components/personal/PersonalAgentContext", () => ({
  usePersonalAgent: () => mocks.usePersonalAgent(),
}));

vi.mock("@/components/WorkspaceContext", () => ({
  useWorkspaceContext: () => mocks.useWorkspaceContext(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mocks.useQueryClient(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => mocks.useRouter(),
}));

vi.mock("@/components/ToastProvider", () => ({
  useToast: () => mocks.useToast(),
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

vi.mock("@/components/personal/PersonalInbox", () => ({
  PersonalInbox: () => <div data-testid="personal-inbox" />,
}));

vi.mock("@/components/personal/PendingSessionView", () => ({
  PendingSessionView: () => <div data-testid="pending-session" />,
}));

vi.mock("@/lib/agent-sessions/actions", () => ({
  createAgentSessionFromPrompt: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/payload", () => ({
  seedSessionQueries: vi.fn(),
}));

afterEach(() => {
  window.sessionStorage.clear();
});

describe("PersonalHome composer focus", () => {
  it("focuses the expanded composer when the personal composer focus event fires", async () => {
    render(<PersonalHome />);

    const composer = screen.getByPlaceholderText("Message Sofia");
    window.dispatchEvent(new Event(PERSONAL_COMPOSER_FOCUS_EVENT));

    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("consumes a pending shortcut focus request after navigation", async () => {
    window.sessionStorage.setItem(PERSONAL_COMPOSER_FOCUS_STORAGE_KEY, "1");

    render(<PersonalHome />);

    const composer = screen.getByPlaceholderText("Message Sofia");
    await waitFor(() => expect(composer).toHaveFocus());
    expect(window.sessionStorage.getItem(PERSONAL_COMPOSER_FOCUS_STORAGE_KEY)).toBeNull();
  });
});
