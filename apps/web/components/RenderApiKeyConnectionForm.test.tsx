import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RenderApiKeyConnectionForm } from "@/components/RenderApiKeyConnectionForm";
import { saveRenderApiKeyAction } from "@/lib/integrations/render-actions";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/integrations/render-actions", () => ({ saveRenderApiKeyAction: vi.fn() }));

describe("RenderApiKeyConnectionForm", () => {
  it("explains the account-level key and disables an empty save", () => {
    render(<RenderApiKeyConnectionForm connected={false} />);

    expect(screen.getByLabelText("Render API key")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Save API key" })).toBeDisabled();
    expect(screen.getByText(/account-level access/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create a render api key/i })).toHaveAttribute(
      "href",
      "https://dashboard.render.com/u/settings/api-keys",
    );
  });

  it("saves a replacement key and refreshes the plugin state", async () => {
    const user = userEvent.setup();
    vi.mocked(saveRenderApiKeyAction).mockResolvedValue({ ok: true });
    render(<RenderApiKeyConnectionForm connected />);

    expect(screen.getByText("API key saved")).toBeInTheDocument();
    await user.type(screen.getByLabelText("New Render API key"), "rnd_abcdefgh12345678");
    await user.click(screen.getByRole("button", { name: "Update API key" }));

    expect(saveRenderApiKeyAction).toHaveBeenCalledWith("rnd_abcdefgh12345678");
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("surfaces provider validation errors without clearing the key", async () => {
    const user = userEvent.setup();
    vi.mocked(saveRenderApiKeyAction).mockResolvedValue({
      ok: false,
      error: "Render rejected this API key. Check it and try again.",
    });
    render(<RenderApiKeyConnectionForm connected={false} />);

    const input = screen.getByLabelText("Render API key");
    await user.type(input, "rnd_abcdefgh12345678");
    await user.click(screen.getByRole("button", { name: "Save API key" }));

    expect(screen.getByText("Render rejected this API key. Check it and try again.")).toBeVisible();
    expect(input).toHaveValue("rnd_abcdefgh12345678");
  });
});
