import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PersonalShell, { type PersonalShellProps } from "@/components/personal/PersonalShell";
import { PERSONAL_COMPOSER_FOCUS_STORAGE_KEY } from "@/lib/personal/composer-shortcut";

const mocks = vi.hoisted(() => ({
  pathname: "/personal/session/sess_123",
  push: vi.fn(),
  hasPersonalGitHubIntegrationRequest: vi.fn(() => false),
  setUserTimezone: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/components/PersonalSidebar", () => ({
  default: () => <aside data-testid="personal-sidebar" />,
}));

vi.mock("@/components/personal/PersonalAgentContext", () => ({
  PersonalAgentProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/personal/PersonalCapabilityPanel", () => ({
  hasPersonalGitHubIntegrationRequest: (body: string) => {
    void body;
    return mocks.hasPersonalGitHubIntegrationRequest();
  },
}));

vi.mock("@/components/session-split/PersonalSessionSplit", () => ({
  PersonalSplitProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/MobileInspectorContext", () => ({
  useMobileInspector: () => ({ handle: null }),
}));

vi.mock("@/components/ToastProvider", () => ({
  useToast: () => ({ showError: vi.fn() }),
}));

vi.mock("@/lib/personal/actions", () => ({
  addPersonalAgentIntegration: vi.fn(),
  addPersonalAgentSkill: vi.fn(),
  addPersonalAgentTool: vi.fn(),
}));

vi.mock("@/lib/useDrawerGesture", () => ({
  useDrawerGesture: () => ({
    left: { dragging: false, progress: 0 },
    right: { dragging: false, progress: 0 },
  }),
}));

vi.mock("@/lib/useIsMobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/lib/users/actions", () => ({
  setUserTimezone: (...args: unknown[]) => mocks.setUserTimezone(...args),
}));

const baseConfig: AgentConfig = {
  schemaVersion: "agent.v1",
  engine: "opencompany",
  title: "Sofia",
  instructions: "Help me.",
  model: {
    provider: "vercel-ai-gateway",
    name: "moonshotai/kimi-k2.6",
  },
  tools: [],
  brain: [],
  integrations: { github: { repositories: [] } },
  triggers: [],
};

function shellProps(): PersonalShellProps {
  const props: PersonalShellProps = {
    agent: {
      id: "agt_personal",
      name: "Sofia",
      defaultModel: "moonshotai/kimi-k2.6",
      path: null,
      config: baseConfig,
      body: "Help me.",
      content: { type: "doc", content: [] },
    },
    userName: "Lou",
    userEmail: "lou@example.com",
    userTimezone: "America/New_York",
    userTimezoneSource: "manual",
    workspaceId: "wks_test",
    workspaceName: "OpenCompany",
    workspaces: [],
    initialSessions: [],
    contextFiles: [],
    personalSkills: [],
    githubIntegrationStatus: "not_connected",
    githubRepositories: [],
    workspaceAgents: [],
    integrationConnections: {
      github: false,
      gmail: false,
      google_calendar: false,
      google_drive: false,
      linear: false,
      slack: false,
      posthog: false,
      betterstack: false,
      braintrust: false,
      notion: false,
    },
    integrationDetails: {},
    toolPolicies: {},
    proMode: false,
    companySurfaceEnabled: true,
    codexEngineEnabled: false,
    children: <div data-testid="personal-content" />,
  };
  return props;
}

afterEach(() => {
  mocks.pathname = "/personal/session/sess_123";
  mocks.push.mockReset();
  window.sessionStorage.clear();
});

describe("PersonalShell shortcuts", () => {
  it("opens the full personal composer from Cmd+K", () => {
    render(<PersonalShell {...shellProps()} />);

    const event = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(window.sessionStorage.getItem(PERSONAL_COMPOSER_FOCUS_STORAGE_KEY)).toBe("1");
    expect(mocks.push).toHaveBeenCalledWith("/personal");
  });
});
