import { beforeEach, describe, expect, it, vi } from "vitest";
import GoatChatPage from "./page";

const routeMock = vi.hoisted(() => vi.fn(() => null));
const loadChatMock = vi.hoisted(() => vi.fn());
const redirectMock = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
);

vi.mock("next/navigation", () => ({ redirect: redirectMock }));

vi.mock("@/components/GoatRoutes", () => ({
  GoatHomeRoute: routeMock,
}));

vi.mock("@/lib/chat", () => ({
  loadCurrentGoatChatSessionById: loadChatMock,
}));

describe("Goat chat route", () => {
  beforeEach(() => {
    routeMock.mockClear();
    loadChatMock.mockReset();
    redirectMock.mockClear();
  });

  it("renders an existing canonical conversation", async () => {
    const chat = {
      id: "goat_chat_1",
      title: "Existing chat",
      model: "moonshotai/kimi-k3",
      engine: "opencompany",
      messages: [],
    };
    loadChatMock.mockResolvedValue(chat);

    const page = await GoatChatPage({
      params: Promise.resolve({ chatId: " goat_chat_1 " }),
    });

    expect(loadChatMock).toHaveBeenCalledWith("goat_chat_1");
    expect(page.props).toEqual({ chatId: "goat_chat_1", initialChat: chat });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("redirects a nonexistent conversation before mounting chat collections", async () => {
    loadChatMock.mockResolvedValue(null);

    await expect(
      GoatChatPage({ params: Promise.resolve({ chatId: "goat_chat_missing" }) }),
    ).rejects.toThrow("redirect:/");

    expect(loadChatMock).toHaveBeenCalledWith("goat_chat_missing");
    expect(redirectMock).toHaveBeenCalledWith("/");
    expect(routeMock).not.toHaveBeenCalled();
  });

  it("redirects an empty route id without calling the API", async () => {
    await expect(GoatChatPage({ params: Promise.resolve({ chatId: "   " }) })).rejects.toThrow(
      "redirect:/",
    );

    expect(loadChatMock).not.toHaveBeenCalled();
    expect(routeMock).not.toHaveBeenCalled();
  });
});
