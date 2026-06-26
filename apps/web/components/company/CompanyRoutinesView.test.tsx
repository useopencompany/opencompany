import type { AgentConfig, AgentScheduleTriggerConfig } from "@opencompany/agent-runtime/types";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRow } from "@/lib/collections/types";
import CompanyRoutinesView from "./CompanyRoutinesView";

const mocks = vi.hoisted(() => ({
  dialogProps: null as null | {
    title?: string;
    onSave: (trigger: AgentScheduleTriggerConfig) => void;
  },
  rows: [] as unknown[],
  push: vi.fn(),
  showError: vi.fn(),
  showToast: vi.fn(),
  useLiveQuery: vi.fn(),
  runAgentScheduleNow: vi.fn(),
  updateWorkspaceAgentSchedules: vi.fn(),
}));

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: (...args: unknown[]) => mocks.useLiveQuery(...args),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({}),
}));

vi.mock("@/components/agent-schedules/ScheduleDialog", () => ({
  ScheduleDialog: (props: {
    title?: string;
    onSave: (trigger: AgentScheduleTriggerConfig) => void;
  }) => {
    mocks.dialogProps = props;
    return <div aria-label={props.title ?? "Schedule"} role="dialog" />;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("next/link", () => ({
  default: (input: ComponentProps<"a"> & { prefetch?: boolean }) => {
    const { href, children, prefetch, ...props } = input;
    void prefetch;
    return (
      <a href={typeof href === "string" ? href : ""} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("@/components/CollectionsProvider", () => ({
  useCollections: () => ({ agents: {} }),
}));

vi.mock("@/components/ToastProvider", () => ({
  useToast: () => ({ showError: mocks.showError, showToast: mocks.showToast }),
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => true,
}));

vi.mock("@/components/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({ workspaceId: "wks_123", userId: "usr_123" }),
}));

vi.mock("@/lib/agent-schedules/actions", () => ({
  runAgentScheduleNow: (...args: unknown[]) => mocks.runAgentScheduleNow(...args),
  updateWorkspaceAgentSchedules: (...args: unknown[]) =>
    mocks.updateWorkspaceAgentSchedules(...args),
}));

vi.mock("@/lib/agent-sessions/payload", () => ({
  seedSessionQueries: vi.fn(),
}));

const baseConfig: AgentConfig = {
  schemaVersion: "agent.v1",
  engine: "opencompany",
  title: "Company Agent",
  instructions: "Help the company.",
  model: {
    provider: "vercel-ai-gateway",
    name: "openai/gpt-5.4-mini",
  },
  tools: [],
  brain: [],
  integrations: {
    github: {
      repositories: [],
    },
  },
  triggers: [],
};

function companyAgent(triggers: AgentConfig["triggers"] = []): AgentRow {
  return {
    id: "agt_company",
    workspace_id: "wks_123",
    user_id: null,
    is_default: false,
    path: "agents/company.agent",
    name: "Company Agent",
    body: "Help the company.",
    commit_sha: null,
    content_hash: null,
    version: 1,
    github_blob_sha: null,
    github_commit_sha: null,
    github_synced_hash: null,
    github_synced_at: null,
    github_sync_status: "synced",
    github_sync_error: null,
    content: { type: "doc", content: [] },
    config: { ...baseConfig, triggers },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function schedule(id: string, prompt: string): AgentScheduleTriggerConfig {
  return {
    id,
    type: "agent.schedule",
    cron: "0 9 * * 1-5",
    timezone: "UTC",
    prompt,
    enabled: true,
  };
}

describe("CompanyRoutinesView", () => {
  beforeEach(() => {
    mocks.dialogProps = null;
    mocks.rows = [companyAgent()];
    mocks.useLiveQuery.mockImplementation(() => ({ data: mocks.rows, isLoading: false }));
    mocks.updateWorkspaceAgentSchedules.mockResolvedValue({ ok: true });
    mocks.runAgentScheduleNow.mockResolvedValue({ ok: true });
  });

  it("bases consecutive saves on optimistic schedules while the live agent row is stale", async () => {
    const { unmount } = render(<CompanyRoutinesView />);

    fireEvent.click(screen.getAllByRole("button", { name: "New routine" })[0]!);
    expect(screen.getByRole("dialog", { name: "New routine" })).toBeInTheDocument();
    act(() => {
      mocks.dialogProps?.onSave(schedule("first-routine", "First routine"));
    });

    await waitFor(() => expect(mocks.updateWorkspaceAgentSchedules).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "New routine" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "New routine" }));
    expect(screen.getByRole("dialog", { name: "New routine" })).toBeInTheDocument();
    act(() => {
      mocks.dialogProps?.onSave(schedule("second-routine", "Second routine"));
    });

    await waitFor(() => expect(mocks.updateWorkspaceAgentSchedules).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "New routine" })).toBeEnabled());

    const firstSave = mocks.updateWorkspaceAgentSchedules.mock.calls[0]?.[1] as
      | AgentScheduleTriggerConfig[]
      | undefined;
    const secondSave = mocks.updateWorkspaceAgentSchedules.mock.calls[1]?.[1] as
      | AgentScheduleTriggerConfig[]
      | undefined;

    expect(firstSave?.map((schedule) => schedule.prompt)).toEqual(["First routine"]);
    expect(secondSave?.map((schedule) => schedule.prompt)).toEqual([
      "First routine",
      "Second routine",
    ]);

    unmount();
  }, 20_000);
});
