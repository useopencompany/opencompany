import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPLETED_CONVERSATION_DOCUMENT_TITLE,
  useConversationTabTitle,
} from "./useConversationTabTitle";

describe("useConversationTabTitle", () => {
  afterEach(() => {
    document.title = "opencompany";
    setVisibility("visible");
  });

  it("shows a completion cue for an unseen result in a hidden active tab", () => {
    document.title = "opencompany";
    setVisibility("hidden");

    renderHook(() => useConversationTabTitle({ active: true, completedUnseen: true }));

    expect(document.title).toBe(COMPLETED_CONVERSATION_DOCUMENT_TITLE);
  });

  it("restores the normal title when the reader returns", () => {
    document.title = "opencompany";
    setVisibility("hidden");
    renderHook(() => useConversationTabTitle({ active: true, completedUnseen: true }));

    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(document.title).toBe("opencompany");
  });

  it("clears a stale cue when work starts or the pane becomes inactive", () => {
    document.title = "opencompany";
    setVisibility("hidden");
    const { rerender } = renderHook(
      ({ active, completedUnseen }) => useConversationTabTitle({ active, completedUnseen }),
      { initialProps: { active: true, completedUnseen: true } },
    );

    rerender({ active: true, completedUnseen: false });
    expect(document.title).toBe("opencompany");

    rerender({ active: true, completedUnseen: true });
    expect(document.title).toBe(COMPLETED_CONVERSATION_DOCUMENT_TITLE);

    rerender({ active: false, completedUnseen: true });
    expect(document.title).toBe("opencompany");
  });

  it("restores the title owned by the page when it unmounts", () => {
    document.title = "Conversation - opencompany";
    setVisibility("hidden");
    const { unmount } = renderHook(() =>
      useConversationTabTitle({ active: true, completedUnseen: true }),
    );

    unmount();

    expect(document.title).toBe("Conversation - opencompany");
  });
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}
