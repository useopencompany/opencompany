import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainActivity, BrainRecentActivity } from "./BrainActivity";

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
  createCollections: () => {
    const collections = {
      brainSourceItems: "brainSourceItems",
      brainCollections: () => ({
        ingestJobs: "ingestJobs",
      }),
    };
    return collections;
  },
}));

describe("BrainActivity", () => {
  beforeEach(() => {
    queryRows.jobs = [];
    queryRows.items = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

    render(<BrainActivity brainRef="goat_brain_1" />);

    expect(screen.getByRole("link", { name: "Pricing teardown" })).toHaveAttribute(
      "href",
      "/brain/goat_brain_1/concepts/pricing-teardown",
    );
    expect(screen.getByRole("link", { name: "Acme" })).toHaveAttribute(
      "href",
      "/brain/goat_brain_1/companies/customers/acme",
    );
  });

  it("shows only successful filings in the overview by default", () => {
    queryRows.jobs = [
      job({
        id: "gbjob_filed",
        source_item_id: "gbsrc_filed",
        status: "succeeded",
        completed_at: "2026-07-09T10:01:00.000Z",
        result: { summary: "Filed one page." },
      }),
      job({
        id: "gbjob_skipped",
        source_item_id: "gbsrc_skipped",
        status: "skipped",
        completed_at: "2026-07-09T10:02:00.000Z",
        result: { skipped: true, summary: "No durable knowledge." },
      }),
    ];
    queryRows.items = [
      item({ id: "gbsrc_filed", title: "Useful customer signal" }),
      item({ id: "gbsrc_skipped", title: "Routine notification" }),
    ];

    render(<BrainRecentActivity brainRef="goat_brain_1" />);

    expect(screen.getByText("Filed into brain")).toBeInTheDocument();
    expect(screen.getByText("Useful customer signal")).toBeInTheDocument();
    expect(screen.queryByText("Received")).not.toBeInTheDocument();
    expect(screen.queryByText("Skipped filing")).not.toBeInTheDocument();
    expect(screen.queryByText("Routine notification")).not.toBeInTheDocument();
  });

  it("filters overview activity before applying its row limit", () => {
    const skippedJobs = Array.from({ length: 30 }, (_, index) =>
      job({
        id: `gbjob_skipped_${index}`,
        source_item_id: `gbsrc_skipped_${index}`,
        status: "skipped",
        completed_at: `2026-07-09T10:${String(index + 2).padStart(2, "0")}:00.000Z`,
        result: { skipped: true },
      }),
    );
    queryRows.jobs = [
      ...skippedJobs,
      job({
        id: "gbjob_filed",
        source_item_id: "gbsrc_filed",
        status: "succeeded",
        completed_at: "2026-07-09T10:01:00.000Z",
        result: { summary: "Filed one page." },
      }),
    ];
    queryRows.items = [
      ...skippedJobs.map((skippedJob, index) =>
        item({ id: skippedJob.source_item_id, title: `Routine notification ${index}` }),
      ),
      item({ id: "gbsrc_filed", title: "Older useful signal" }),
    ];

    render(<BrainRecentActivity brainRef="goat_brain_1" limit={1} />);

    expect(screen.getByText("Older useful signal")).toBeInTheDocument();
  });

  it("can show received and skipped overview activity", () => {
    queryRows.jobs = [
      job({
        status: "skipped",
        completed_at: "2026-07-09T10:01:00.000Z",
        result: { skipped: true },
      }),
    ];
    queryRows.items = [item()];

    const { rerender } = render(<BrainRecentActivity brainRef="goat_brain_1" filter="received" />);

    expect(screen.getByText("Captured to inbox")).toBeInTheDocument();
    expect(screen.queryByText("Skipped filing")).not.toBeInTheDocument();

    rerender(<BrainRecentActivity brainRef="goat_brain_1" filter="skipped" />);

    expect(screen.getByText("Skipped filing")).toBeInTheDocument();
    expect(screen.queryByText("Captured to inbox")).not.toBeInTheDocument();
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

    render(<BrainActivity brainRef="goat_brain_1" />);

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

    render(<BrainActivity brainRef="goat_brain_1" />);

    expect(screen.getByText("Filing into brain…")).toBeInTheDocument();
    expect(screen.getAllByText("Trace ID")).toHaveLength(2);
    expect(screen.getAllByText("gbjob_1")).toHaveLength(2);
  });

  it("loads brain-scoped source metadata when the user-scoped source item is absent", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          sourceItems: [
            item({
              source_provider: "linear",
              source_type: "issue",
              title: "G-57 pricing model follow-up",
            }),
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    queryRows.jobs = [
      job({
        source_provider: "linear",
        status: "succeeded",
        completed_at: "2026-07-09T10:01:00.000Z",
        result: {
          summary: "Filed one page.",
        },
      }),
    ];
    queryRows.items = [];

    render(<BrainActivity brainRef="goat_brain_1" />);

    expect(await screen.findAllByText("G-57 pricing model follow-up")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/brain-activity/source-items");
    expect(url.searchParams.get("brain_ref")).toBe("goat_brain_1");
    expect(url.searchParams.get("source_item_ids")).toBe("gbsrc_1");

    fetchMock.mockRestore();
  });

  it("opens a completed agent trace with collapsed details and raw JSON", async () => {
    const user = userEvent.setup();
    queryRows.jobs = [
      job({
        status: "succeeded",
        completed_at: "2026-07-09T10:01:00.000Z",
        result: {
          summary: "Filed one page.",
          durationMs: 80_000,
          trace: trace(),
        },
      }),
    ];
    queryRows.items = [item()];

    render(<BrainActivity brainRef="goat_brain_1" />);

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
    expect(within(dialog).getByText(/Run 1m, 20\.0s/)).toBeInTheDocument();
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
    model: "anthropic/claude-sonnet-5",
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
