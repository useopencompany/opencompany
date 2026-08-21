import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorState } from "./AppErrorState";

const captureException = vi.hoisted(() => vi.fn());

vi.mock("@sentry/nextjs", () => ({ captureException }));

describe("AppErrorState", () => {
  beforeEach(() => captureException.mockClear());

  it("shows a server digest as the support id and retries on request", () => {
    const reset = vi.fn();
    const error = Object.assign(new Error("server render failed"), { digest: "3642332288" });

    render(<AppErrorState error={error} reset={reset} />);

    expect(screen.getByRole("heading", { name: "We couldn't open this page" })).toBeVisible();
    expect(screen.getByText("3642332288")).toBeVisible();
    expect(captureException).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("captures a client boundary failure with its displayed support id", async () => {
    const error = new Error("client render failed");

    render(<AppErrorState error={error} reset={vi.fn()} />);

    const supportId = screen.getByText(/^client_/u).textContent;
    await waitFor(() =>
      expect(captureException).toHaveBeenCalledWith(error, {
        tags: {
          event: "opencompany.web_client_error_boundary",
          support_id: supportId,
        },
      }),
    );
  });
});
