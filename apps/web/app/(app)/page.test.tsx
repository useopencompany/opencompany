import { beforeEach, describe, expect, it, vi } from "vitest";
import HomePage from "./page";

const routeMock = vi.hoisted(() => vi.fn(() => null));
const loadProjectNameMock = vi.hoisted(() => vi.fn());
const redirectMock = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
);

vi.mock("next/navigation", () => ({ redirect: redirectMock }));

vi.mock("@/components/Routes", () => ({
  HomeRoute: routeMock,
}));

vi.mock("@/lib/projects-server", () => ({
  loadProjectName: loadProjectNameMock,
}));

describe("opencompany home route", () => {
  beforeEach(() => {
    routeMock.mockClear();
    loadProjectNameMock.mockReset();
    loadProjectNameMock.mockResolvedValue(null);
    redirectMock.mockClear();
  });

  it("renders the plain home screen without a project", async () => {
    const page = await HomePage({ searchParams: Promise.resolve({}) });

    expect(page.props).toEqual({ chatId: null, projectId: null, projectName: null });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("redirects a legacy chat param to the conversation route", async () => {
    await expect(
      HomePage({ searchParams: Promise.resolve({ chat: " goat_chat_1 " }) }),
    ).rejects.toThrow("redirect:/chat/goat_chat_1");

    expect(loadProjectNameMock).not.toHaveBeenCalled();
  });

  it("names the project a new chat was started from", async () => {
    loadProjectNameMock.mockResolvedValue("product");

    const page = await HomePage({ searchParams: Promise.resolve({ project: " project_1 " }) });

    expect(loadProjectNameMock).toHaveBeenCalledWith("project_1");
    expect(page.props).toEqual({
      chatId: null,
      projectId: "project_1",
      projectName: "product",
    });
  });

  it("falls back to home when the project is not visible to the reader", async () => {
    loadProjectNameMock.mockResolvedValue(null);

    await expect(
      HomePage({ searchParams: Promise.resolve({ project: "project_gone" }) }),
    ).rejects.toThrow("redirect:/");

    expect(routeMock).not.toHaveBeenCalled();
  });
});
