import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoatBrainActivity } from "./GoatBrainActivity";

const queryRows = vi.hoisted(() => ({
  jobs: [] as unknown[],
  items: [] as unknown[],
}));

vi.mock("@opencompany/ui/components/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: vi.fn((query: unknown) => {
    const source = String(query);
    return {
      data: source.includes("ingestJobs") ? queryRows.jobs : queryRows.items,
      isLoading: false,
    };
  }),
}));

vi.mock("@/lib/task-collections", () => ({
  createGoatCollections: () => {
    const collections = {
      brainSourceItems: "brainSourceItems",
      brainCollections: () => ({
        ingestJobs: "ingestJobs",
      }),
    };
    return collections;
  },
}));

describe("GoatBrainActivity", () => {
  beforeEach(() => {
    queryRows.jobs = [];
    queryRows.items = [];
  });

  it("renders quick links for pages on filed entries", () => {
    queryRows.jobs = [
      job({
        status: "succeeded",
        completed_at: "2026-07-09T10:01:00.000Z",
        result: {
          summary: "Filed two pages.",
          pages: [
            {
              brainId: "pricing-teardown",
              folderPath: "concepts",
              title: "Pricing teardown",
              action: "created",
            },
            {
              brainId: "acme",
              folderPath: "companies/customers",
              title: "Acme",
              action: "updated",
            },
          ],
        },
      }),
    ];
    queryRows.items = [item()];

    render(<GoatBrainActivity brainRef="goat_brain_1" />);

    expect(screen.getByRole("link", { name: "Pricing teardown" })).toHaveAttribute(
      "href",
      "/brain/goat_brain_1/concepts/pricing-teardown",
    );
    expect(screen.getByRole("link", { name: "Acme" })).toHaveAttribute(
      "href",
      "/brain/goat_brain_1/companies/customers/acme",
    );
  });

  it("bounds visible quick links and reports the hidden count", () => {
    queryRows.jobs = [
      job({
        status: "succeeded",
        result: {
          summary: "Filed many pages.",
          pages: Array.from({ length: 6 }, (_, index) => ({
            brainId: `page-${index + 1}`,
            folderPath: "notes",
            title: `Page ${index + 1}`,
            action: "created",
          })),
        },
      }),
    ];
    queryRows.items = [item()];

    render(<GoatBrainActivity brainRef="goat_brain_1" />);

    expect(screen.getAllByRole("link")).toHaveLength(4);
    expect(screen.getByText("+2 more")).toBeInTheDocument();
  });

  it("shows the trace id while an ingest job is running", () => {
    queryRows.jobs = [
      job({
        status: "running",
        updated_at: "2026-07-09T10:00:30.000Z",
      }),
    ];
    queryRows.items = [item()];

    render(<GoatBrainActivity brainRef="goat_brain_1" />);

    expect(screen.getByText("Filing into brain…")).toBeInTheDocument();
    expect(screen.getAllByText("Trace ID")).toHaveLength(2);
    expect(screen.getAllByText("gbjob_1")).toHaveLength(2);
  });

  it("opens a completed agent trace with collapsed details and raw JSON", async () => {
    const user = userEvent.setup();
    queryRows.jobs = [
      job({
        status: "succeeded",
        completed_at: "2026-07-09T10:01:00.000Z",
        result: {
          summary: "Filed one page.",
          trace: trace(),
        },
      }),
    ];
    queryRows.items = [item()];

    render(<GoatBrainActivity brainRef="goat_brain_1" />);

    await user.click(screen.getByRole("button", { name: "Trace" }));

    expect(screen.getByText("Agent run trace")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("flex", "flex-col", "overflow-hidden");
    expect(screen.getByTestId("brain-ingest-trace-scroll")).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
    );
    expect(within(dialog).getByText("Pricing teardown reference")).toBeInTheDocument();
    expect(within(dialog).getByText("Trace ID")).toBeInTheDocument();
    expect(within(dialog).getByText("gbjob_1")).toBeInTheDocument();
    const toolRow = screen.getByTestId("brain-ingest-trace-tool-goat_brain_call_1");
    expect(within(toolRow).queryByText("Stdout")).not.toBeInTheDocument();
    expect(screen.queryByText(/"schemaVersion"/)).not.toBeInTheDocument();

    await user.click(within(toolRow).getByRole("button", { name: /goat_brain query Pricing/i }));

    expect(within(toolRow).getByText("Stdout")).toBeInTheDocument();
    expect(within(toolRow).getByText("Pricing page")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Raw JSON/i }));

    expect(screen.getByText(/"schemaVersion": "goat\.brain_ingest_trace\.v1"/)).toBeInTheDocument();
  });
});

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "gbjob_1",
    source_item_id: "gbsrc_1",
    user_workos_id: "user_1",
    source_provider: "goat-chat",
    source_connection_id: "session_1",
    integration_id: null,
    brain_ref: "goat_brain_1",
    kind: "brain_agent_ingest",
    content_hash: "hash",
    status: "queued",
    attempts: 0,
    next_run_at: "2026-07-09T10:00:00.000Z",
    lease_id: null,
    lease_owner: null,
    lease_expires_at: null,
    last_error: null,
    result: {},
    completed_at: null,
    created_at: "2026-07-09T10:00:00.000Z",
    updated_at: "2026-07-09T10:00:00.000Z",
    ...overrides,
  };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "gbsrc_1",
    user_workos_id: "user_1",
    source_provider: "goat-chat",
    source_type: "capture",
    external_id: "pricing-reference",
    title: "Pricing teardown reference",
    occurred_at: "2026-07-09T10:00:00.000Z",
    captured_at: "2026-07-09T10:00:00.000Z",
    content_hash: "hash",
    last_ingest_job_id: "gbjob_1",
    last_ingest_status: "pending",
    last_ingest_error: null,
    last_ingested_at: null,
    created_at: "2026-07-09T10:00:00.000Z",
    updated_at: "2026-07-09T10:00:00.000Z",
    ...overrides,
  };
}

function trace() {
  return {
    schemaVersion: "goat.brain_ingest_trace.v1",
    model: "anthropic/claude-sonnet-4.6",
    steps: 2,
    toolCallCount: 1,
    mutations: 0,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    finalText: "No durable brain material.",
    toolCalls: [
      {
        id: "goat_brain_call_1",
        toolName: "goat_brain",
        command: "query",
        args: ["Pricing"],
        stdinPreview: null,
        status: "completed",
        mutating: false,
        exitCode: 0,
        stdoutPreview: "Pricing page",
        stderrPreview: "",
        errorPreview: "",
        startedAt: "2026-07-09T10:00:00.000Z",
        completedAt: "2026-07-09T10:00:01.000Z",
      },
    ],
    truncatedToolCalls: 0,
    createdAt: "2026-07-09T10:00:02.000Z",
  };
}
