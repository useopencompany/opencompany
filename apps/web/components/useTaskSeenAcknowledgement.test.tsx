import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTaskSeenAcknowledgement } from "./useTaskSeenAcknowledgement";

const appDataMock = vi.hoisted(() => ({
  unreadTaskIds: new Set<string>(),
}));

const taskCommandsMock = vi.hoisted(() => ({
  markHeadlessTaskSeen: vi.fn(async () => ({ id: "task_1" })),
}));

vi.mock("@/components/AppDataProvider", () => ({
  useAppData: () => ({
    workspace: { id: "ws_1", name: "Ada's Workspace", role: "admin" },
    unreadTaskIds: appDataMock.unreadTaskIds,
  }),
}));

vi.mock("@/lib/headless-task-commands", () => taskCommandsMock);

describe("useTaskSeenAcknowledgement", () => {
  afterEach(() => {
    vi.clearAllMocks();
    appDataMock.unreadTaskIds = new Set();
    setVisibility("visible");
  });

  it("acknowledges an unread task once while the document is visible", () => {
    appDataMock.unreadTaskIds = new Set(["task_1"]);

    const { rerender } = renderHook(() => useTaskSeenAcknowledgement("task_1"));
    rerender();

    expect(taskCommandsMock.markHeadlessTaskSeen).toHaveBeenCalledTimes(1);
    expect(taskCommandsMock.markHeadlessTaskSeen).toHaveBeenCalledWith("task_1", {
      scopeKey: "ws_1",
    });
  });

  it("leaves a task that has nothing unread alone", () => {
    renderHook(() => useTaskSeenAcknowledgement("task_1"));

    expect(taskCommandsMock.markHeadlessTaskSeen).not.toHaveBeenCalled();
  });

  it("waits for a hidden document to come back before acknowledging", () => {
    setVisibility("hidden");
    appDataMock.unreadTaskIds = new Set(["task_1"]);

    renderHook(() => useTaskSeenAcknowledgement("task_1"));
    expect(taskCommandsMock.markHeadlessTaskSeen).not.toHaveBeenCalled();

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(taskCommandsMock.markHeadlessTaskSeen).toHaveBeenCalledTimes(1);
  });

  it("acknowledges again when a later run leaves a new unread result", () => {
    appDataMock.unreadTaskIds = new Set(["task_1"]);
    const { rerender } = renderHook(() => useTaskSeenAcknowledgement("task_1"));
    expect(taskCommandsMock.markHeadlessTaskSeen).toHaveBeenCalledTimes(1);

    appDataMock.unreadTaskIds = new Set();
    rerender();
    appDataMock.unreadTaskIds = new Set(["task_1"]);
    rerender();

    expect(taskCommandsMock.markHeadlessTaskSeen).toHaveBeenCalledTimes(2);
  });

  it("lets a later visit retry after a failed acknowledgment", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    taskCommandsMock.markHeadlessTaskSeen.mockRejectedValueOnce(new Error("network unavailable"));
    appDataMock.unreadTaskIds = new Set(["task_1"]);

    const { rerender } = renderHook(() => useTaskSeenAcknowledgement("task_1"));
    await waitFor(() => expect(warn).toHaveBeenCalled());

    document.dispatchEvent(new Event("visibilitychange"));
    rerender();

    expect(taskCommandsMock.markHeadlessTaskSeen).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("does nothing until the route resolves a task", () => {
    appDataMock.unreadTaskIds = new Set(["task_1"]);

    renderHook(() => useTaskSeenAcknowledgement(null));

    expect(taskCommandsMock.markHeadlessTaskSeen).not.toHaveBeenCalled();
  });
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}
