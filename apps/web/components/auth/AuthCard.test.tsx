import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthCard } from "./AuthCard";

vi.mock("@/lib/auth-actions", () => ({
  startGoogleAuth: vi.fn(),
  requestMagicCode: vi.fn(),
  restartAuthentication: vi.fn(),
  selectOrganization: vi.fn(),
  verifyMagicCode: vi.fn(),
}));

afterEach(() => {
  cleanup();
  delete window.opencompanyDesktop;
});

describe("desktop sign-in recovery", () => {
  it("lets users retry a browser sign-in they did not finish", async () => {
    const user = userEvent.setup();
    const signInWithGoogle = vi.fn();
    window.opencompanyDesktop = {
      version: "0.1.0",
      platform: "darwin",
      signInWithGoogle,
      retryConnection: vi.fn(),
    };
    render(<AuthCard mode="sign-in" desktop lastUsedMethod={null} invitationToken="invite" />);
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(signInWithGoogle).toHaveBeenCalledWith("invite");
    expect(screen.getByRole("button", { name: "Waiting for sign-in…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Complete sign-in in your browser");
    await user.click(screen.getByRole("button", { name: "Didn't finish? Try again" }));
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(signInWithGoogle).toHaveBeenCalledTimes(2);
  });

  it("passes the Sentry return path to Google sign-in and account creation", () => {
    const returnPathname = "/integrations/sentry/setup?installationId=install-1&code=grant-1";
    const { container } = render(
      <AuthCard mode="sign-in" lastUsedMethod={null} returnPathname={returnPathname} />,
    );
    expect(container.querySelector('input[name="returnPathname"]')).toHaveValue(returnPathname);
    expect(
      new URL(
        screen.getByRole("link", { name: "Create an account" }).getAttribute("href")!,
        "https://opencompany.example",
      ).searchParams.get("returnPathname"),
    ).toBe(returnPathname);
  });

  it("keeps ordinary browser sign-in unchanged", () => {
    render(<AuthCard mode="sign-in" lastUsedMethod={null} />);
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Didn't finish? Try again" }),
    ).not.toBeInTheDocument();
  });
});
