import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainActivity, BrainRecentActivity } from "./BrainActivity";

const queryRows = vi.hoisted(() => ({
  jobs: [] as unknown[],
  items: [] as unknown[],
}));
const listSourceItems = vi.hoisted(() => vi.fn());
const liveQuery = vi.hoisted(() => vi.fn());
const getBrainCollections = vi.hoisted(() => vi.fn());
const hydration = vi.hoisted(() => ({ value: true }));

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
  useLiveQuery: liveQuery,
}));

vi.mock("@/lib/headless-knowledge-collections", () => ({
  getHeadlessBrainCollections: getBrainCollections,
}));

vi.mock("@/lib/headless-knowledge-commands", () => ({
  listHeadlessBrainSourceItems: listSourceItems,
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => hydration.value,
}));

describe("BrainActivity", () => {
  beforeEach(() => {
    queryRows.jobs = [];
    queryRows.items = [];
    hydration.value = true;
    liveQuery.mockImplementation(() => ({ data: queryRows.jobs, isLoading: false }));
    getBrainCollections.mockReturnValue({ ingestJobs: "ingestJobs" });
    listSourceItems.mockImplementation(async () => queryRows.items);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("server-renders without starting the Brain collection", () => {
    hydration.value = false;

    const html = renderToString(
      <>
        <BrainActivity brainRef="goat_brain_1" />
        <BrainRecentActivity brainRef="goat_brain_1" />
      </>,
    );

    expect(html).toContain("Loading activity");
    expect(getBrainCollections).not.toHaveBeenCalled();
    expect(liveQuery).not.toHaveBeenCalled();
  });

  it("renders quick links for pages on filed entries", () => {
    queryRows.jobs = [
      job({
        status: "succeeded",
        completedAt: "2026-07-09T10:01:00.000Z",
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

  it("shows only successful filings in the overview by default", async () => {
    queryRows.jobs = [
      job({
        id: "gbjob_filed",
        sourceItemId: "gbsrc_filed",
        status: "succeeded",
        completedAt: "2026-07-09T10:01:00.000Z",
        result: { summary: "Filed one page." },
      }),
      job({
        id: "gbjob_skipped",
        sourceItemId: "gbsrc_skipped",
        status: "skipped",
        completedAt: "2026-07-09T10:02:00.000Z",
        result: { skipped: true, summary: "No durable knowledge." },
      }),
    ];
    queryRows.items = [
      item({ id: "gbsrc_filed", title: "Useful customer signal" }),
      item({ id: "gbsrc_skipped", title: "Routine notification" }),
    ];

    render(<BrainRecentActivity brainRef="goat_brain_1" />);

    expect(screen.getByText("Filed into brain")).toBeInTheDocument();
    expect(await screen.findByText("Useful customer signal")).toBeInTheDocument();
    expect(screen.queryByText("Received")).not.toBeInTheDocument();
    expect(screen.queryByText("Skipped filing")).not.toBeInTheDocument();
    expect(screen.queryByText("Routine notification")).not.toBeInTheDocument();
  });

  it("filters overview activity before applying its row limit", async () => {
    const skippedJobs = Array.from({ length: 30 }, (_, index) =>
      job({
        id: `gbjob_skipped_${index}`,
        sourceItemId: `gbsrc_skipped_${index}`,
        status: "skipped",
        completedAt: `2026-07-09T10:${String(index + 2).padStart(2, "0")}:00.000Z`,
        result: { skipped: true },
      }),
    );
    queryRows.jobs = [
      ...skippedJobs,
      job({
        id: "gbjob_filed",
        sourceItemId: "gbsrc_filed",
        status: "succeeded",
        completedAt: "2026-07-09T10:01:00.000Z",
        result: { summary: "Filed one page." },
      }),
    ];
    queryRows.items = [
      ...skippedJobs.map((skippedJob, index) =>
        item({ id: skippedJob.sourceItemId, title: `Routine notification ${index}` }),
      ),
      item({ id: "gbsrc_filed", title: "Older useful signal" }),
    ];

    render(<BrainRecentActivity brainRef="goat_brain_1" limit={1} />);

    expect(await screen.findByText("Older useful signal")).toBeInTheDocument();
  });

  it("can show received and skipped overview activity", () => {
    queryRows.jobs = [
      job({
        status: "skipped",
        completedAt: "2026-07-09T10:01:00.000Z",
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
        updatedAt: "2026-07-09T10:00:30.000Z",
      }),
    ];
    queryRows.items = [item()];

    render(<BrainActivity brainRef="goat_brain_1" />);

    expect(screen.getByText("Filing into brain…")).toBeInTheDocument();
    expect(screen.getAllByText("Trace ID")).toHaveLength(2);
    expect(screen.getAllByText("gbjob_1")).toHaveLength(2);
  });

  it("loads source metadata through the typed Brain resource", async () => {
    queryRows.items = [
      item({
        sourceProvider: "linear",
        sourceType: "issue",
        title: "G-57 pricing model follow-up",
      }),
    ];
    queryRows.jobs = [
      job({
        sourceProvider: "linear",
        status: "succeeded",
        completedAt: "2026-07-09T10:01:00.000Z",
        result: {
          summary: "Filed one page.",
        },
      }),
    ];
    render(<BrainActivity brainRef="goat_brain_1" />);

    expect(await screen.findAllByText("G-57 pricing model follow-up")).toHaveLength(2);
    expect(listSourceItems).toHaveBeenCalledWith("goat_brain_1", ["gbsrc_1"]);
  });

  it("opens a completed agent trace with collapsed details and raw JSON", async () => {
    const user = userEvent.setup();
    queryRows.jobs = [
      job({
        status: "succeeded",
        completedAt: "2026-07-09T10:01:00.000Z",
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

    await user.click(within(toolRow).getByRole("button", { name: /brain query Pricing/i }));

    expect(within(toolRow).getByText("Stdout")).toBeInTheDocument();
    expect(within(toolRow).getByText("Pricing page")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Raw JSON/i }));

    expect(screen.getByText(/"schemaVersion": "goat\.brain_ingest_trace\.v1"/)).toBeInTheDocument();
  });
});

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "gbjob_1",
    sourceItemId: "gbsrc_1",
    sourceProvider: "goat-chat",
    kind: "brain_agent_ingest",
    status: "queued",
    planPaused: false,
    attempts: 0,
    lastError: null,
    result: {},
    completedAt: null,
    createdAt: "2026-07-09T10:00:00.000Z",
    updatedAt: "2026-07-09T10:00:00.000Z",
    ...overrides,
  };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "gbsrc_1",
    sourceProvider: "goat-chat",
    sourceType: "capture",
    externalId: "pricing-reference",
    title: "Pricing teardown reference",
    occurredAt: "2026-07-09T10:00:00.000Z",
    capturedAt: "2026-07-09T10:00:00.000Z",
    lastIngestStatus: "pending",
    lastIngestError: null,
    createdAt: "2026-07-09T10:00:00.000Z",
    updatedAt: "2026-07-09T10:00:00.000Z",
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
