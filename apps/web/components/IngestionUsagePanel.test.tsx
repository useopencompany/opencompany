import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type UsageData, UsagePanel } from "./IngestionUsagePanel";

const emptyUsage: UsageData = {
  breakdown: [],
  ingestedThisMonth: 0,
  pending: 0,
  creditBalanceUsdMicros: 0,
  providers: [],
  recent: [],
};

describe("UsagePanel", () => {
  it("shows sandbox spend alongside model and paid capability spend, including chart details", () => {
    render(
      <UsagePanel
        data={{
          ...emptyUsage,
          breakdown: ["chat", "capabilities", "sandbox"].map((category) => ({
            day: new Date().toISOString().slice(0, 10),
            category: category as UsageData["breakdown"][number]["category"],
            spendUsdMicros: 100_000,
            providerCostUsdMicros: 100_000,
            platformFeeUsdMicros: 0,
          })),
        }}
      />,
    );

    expect(screen.getByText("Sandbox usage").parentElement).toHaveTextContent("$0.10");
    expect(screen.getByText("Paid capabilities")).toBeVisible();
    expect(screen.getByText("Chat")).toBeVisible();
    const bar = screen.getByRole("img", { name: /\$0\.30 total.*Sandbox usage \$0\.10/ });
    fireEvent.focus(bar);
    expect(screen.getAllByText("Sandbox usage")).toHaveLength(2);
    expect(screen.getByText("Total").parentElement).toHaveTextContent("$0.30");
    fireEvent.blur(bar);
    expect(screen.getAllByText("Sandbox usage")).toHaveLength(1);
  });

  it("keeps the empty state when no usage has been billed", () => {
    render(<UsagePanel data={emptyUsage} />);
    expect(screen.getByText("No spend in the last 30 days.")).toBeVisible();
    expect(screen.queryByText("Sandbox usage")).not.toBeInTheDocument();
  });
});
