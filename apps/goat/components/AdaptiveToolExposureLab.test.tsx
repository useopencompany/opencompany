import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeAdaptiveToolQuery } from "@/experiments/adaptive-tool-exposure/activation";
import { AdaptiveToolExposureLab } from "./AdaptiveToolExposureLab";

const INITIAL_QUERY =
  "Find the latest email from Ada, then post a concise summary to Slack #launch.";

describe("AdaptiveToolExposureLab", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders deterministic exposure and lets the user switch examples", async () => {
    const user = userEvent.setup();
    renderLab();

    expect(screen.getByRole("heading", { name: "See what enters the model loop" })).toBeVisible();
    expect(
      screen.getByText("48 simulated Slack, Gmail, Linear, GitHub, Notion, and Calendar tools", {
        exact: false,
      }),
    ).toBeVisible();
    expect(screen.getByText(/search_emails\(query, limit\?\)/)).toBeVisible();
    expect(screen.getByText(/send_message\(channel, text\)/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Lossless recovery" }));

    expect(screen.getByLabelText("Query")).toHaveValue(
      "Add the eyes reaction to Slack message 1784282400.000100 in channel C_LAUNCH.",
    );
  });

  it("posts an analysis request and paints the returned candidate view", async () => {
    const user = userEvent.setup();
    const calendarQuery = "Create a Calendar event tomorrow at 10:00.";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe("/api/experiments/adaptive-tool-exposure");
      expect(init?.method).toBe("POST");
      return Response.json({
        mode: "analyze",
        snapshot: analyzeAdaptiveToolQuery(calendarQuery),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLab();

    const query = screen.getByLabelText("Query");
    await user.clear(query);
    await user.type(query, calendarQuery);
    await user.click(screen.getByRole("button", { name: "Analyze exposure" }));

    await waitFor(() => expect(screen.getByText(/create_event\(/)).toBeVisible());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      mode: "analyze",
      query: calendarQuery,
    });
  });
});

function renderLab() {
  render(
    <AdaptiveToolExposureLab
      initialQuery={INITIAL_QUERY}
      initialSnapshot={analyzeAdaptiveToolQuery(INITIAL_QUERY)}
      modelOptions={[{ id: "openai/gpt-5.5", label: "GPT-5.5" }]}
    />,
  );
}
