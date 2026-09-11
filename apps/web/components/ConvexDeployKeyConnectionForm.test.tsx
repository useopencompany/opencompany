import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConvexDeployKeyConnectionForm } from "@/components/ConvexDeployKeyConnectionForm";
import { saveConvexApiKeyAction } from "@/lib/integrations/convex-actions";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/integrations/convex-actions", () => ({ saveConvexApiKeyAction: vi.fn() }));

describe("ConvexDeployKeyConnectionForm", () => {
  it("explains the deployment-scoped key and disables an empty save", () => {
    render(<ConvexDeployKeyConnectionForm connected={false} />);

    expect(screen.getByLabelText("Convex deploy key")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Save deploy key" })).toBeDisabled();
    expect(screen.getByText(/Production supports schema/i)).toBeInTheDocument();
    expect(screen.getByText(/deployment:functions:runInternalQueries/i)).toBeInTheDocument();
    expect(screen.getByText(/deployment:data:view/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create a convex deploy key/i })).toHaveAttribute(
      "href",
      "https://docs.convex.dev/cli/deploy-key-types",
    );
  });

  it("saves a replacement key and refreshes the plugin state", async () => {
    const user = userEvent.setup();
    vi.mocked(saveConvexApiKeyAction).mockResolvedValue({ ok: true });
    render(<ConvexDeployKeyConnectionForm connected />);

    expect(screen.getByText("deploy key saved")).toBeInTheDocument();
    await user.type(
      screen.getByLabelText("New Convex deploy key"),
      "dev:happy-animal-123|abcdefgh",
    );
    await user.click(screen.getByRole("button", { name: "Update deploy key" }));

    expect(saveConvexApiKeyAction).toHaveBeenCalledWith("dev:happy-animal-123|abcdefgh");
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("surfaces provider validation errors without clearing the key", async () => {
    const user = userEvent.setup();
    vi.mocked(saveConvexApiKeyAction).mockResolvedValue({
      ok: false,
      error: "Convex rejected this deploy key. Check it and try again.",
    });
    render(<ConvexDeployKeyConnectionForm connected={false} />);

    const input = screen.getByLabelText("Convex deploy key");
    await user.type(input, "dev:happy-animal-123|abcdefgh");
    await user.click(screen.getByRole("button", { name: "Save deploy key" }));

    expect(
      screen.getByText("Convex rejected this deploy key. Check it and try again."),
    ).toBeVisible();
    expect(input).toHaveValue("dev:happy-animal-123|abcdefgh");
  });
});
