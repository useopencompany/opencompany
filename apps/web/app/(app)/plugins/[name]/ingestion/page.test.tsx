import { beforeEach, describe, expect, it, vi } from "vitest";
import PluginIngestionPage from "./page";

const currentUserMock = vi.hoisted(() => vi.fn());
const attioStateMock = vi.hoisted(() => vi.fn());
const attioSetupMock = vi.hoisted(() => vi.fn(() => null));
const fathomRouteMock = vi.hoisted(() => vi.fn(() => null));
const pageContentMock = vi.hoisted(() => vi.fn(() => null));

vi.mock("@/components/AttioIntegrationSetup", () => ({ AttioIntegrationSetup: attioSetupMock }));
vi.mock("@/components/Routes", () => ({ FathomIngestionRoute: fathomRouteMock }));
vi.mock("@/components/PageContent", () => ({ PageContent: pageContentMock }));
vi.mock("@/lib/auth", () => ({ currentUser: currentUserMock }));
vi.mock("@/lib/integrations/attio", () => ({ getAttioIntegrationState: attioStateMock }));

function renderPage(name: string) {
  return PluginIngestionPage({ params: Promise.resolve({ name }) });
}

describe("PluginIngestionPage", () => {
  beforeEach(() => {
    currentUserMock.mockResolvedValue({ user: { workosUserId: "user_1" } });
    attioStateMock.mockResolvedValue({ status: "disconnected" });
  });

  it.each(["attio", "Attio", "ATTIO"])("loads Attio ingestion state for %s", async (name) => {
    const element = await renderPage(name);
    // The page returns the Attio section as an unrendered element; invoke it to reach its load.
    const section = await element.type();

    expect(attioStateMock).toHaveBeenCalledWith("user_1");
    expect(section.type).toBe(pageContentMock);
    expect(section.props.backLink).toEqual({ href: "/plugins/attio", label: "Attio plugin" });
  });

  it.each(["fathom", "Fathom"])("renders the Fathom ingestion route for %s", async (name) => {
    const element = await renderPage(name);

    expect(element.type).toBe(fathomRouteMock);
    expect(attioStateMock).not.toHaveBeenCalled();
  });

  // Plugins without an ingestion connection keep the reader inside the app with a way back,
  // matching how the plugin detail page handles a plugin it cannot find.
  it("offers a way back to the plugin when it has no ingestion connection", async () => {
    const element = await renderPage("linear");

    expect(element.type).toBe(pageContentMock);
    expect(element.props.title).toBe("Ingestion not available");
    expect(element.props.backLink).toEqual({ href: "/plugins/linear", label: "Plugin" });
  });

  it("encodes the plugin name in the back link", async () => {
    const element = await renderPage("a b/c");

    expect(element.props.backLink.href).toBe("/plugins/a%20b%2Fc");
  });
});
