import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentWorkspace } from "@/lib/auth";
import { ensurePersonalAgent } from "@/lib/personal/scaffold";
import PersonalOnboardingLayout from "./layout";
import PersonalOnboardingPage from "./page";

vi.mock("@opencompany/analytics/client", () => ({
  AnalyticsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/CollectionsProvider", () => ({
  CollectionsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ObservabilityContext", () => ({
  ObservabilityContext: () => null,
}));

vi.mock("@/components/QueryProvider", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ToastProvider", () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/WorkspaceContext", () => ({
  WorkspaceProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/personal/PersonalOnboardingChat", () => ({
  PersonalOnboardingChat: () => null,
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

vi.mock("@/lib/personal/scaffold", () => ({
  ensurePersonalAgent: vi.fn(),
}));

const currentWorkspaceMock = vi.mocked(currentWorkspace);
const ensurePersonalAgentMock = vi.mocked(ensurePersonalAgent);

const workspaceContext = {
  authUser: {
    id: "user_123",
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
  },
  user: {
    id: "usr_123",
    email: "ada@example.com",
    firstName: "Ada",
  },
  workspace: {
    id: "wks_123",
  },
};

describe("personal onboarding route gate", () => {
  beforeEach(() => {
    currentWorkspaceMock.mockResolvedValue(workspaceContext as never);
    ensurePersonalAgentMock.mockResolvedValue({ id: "agt_123" } as never);
  });

  it("lets the personal onboarding layout render for users who have not completed onboarding", async () => {
    await PersonalOnboardingLayout({ children: <div /> });

    expect(currentWorkspaceMock).toHaveBeenCalledWith({ skipOnboarding: true });
  });

  it("lets the personal onboarding page render for users who have not completed onboarding", async () => {
    await PersonalOnboardingPage();

    expect(currentWorkspaceMock).toHaveBeenCalledWith({ skipOnboarding: true });
  });
});
