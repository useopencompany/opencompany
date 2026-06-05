import { describe, expect, it } from "vitest";
import { sidebarDotKind } from "./sidebar-status";

const T0 = "2026-06-05T10:00:00.000Z";
const T1 = "2026-06-05T11:00:00.000Z"; // after T0

describe("sidebarDotKind", () => {
  it("shows the status dot for actively-working statuses", () => {
    for (const status of ["running", "provisioning", "awaiting_approval", "awaiting_input"]) {
      expect(sidebarDotKind({ status, updatedAt: T0, seenAt: null, isOpen: false })).toBe("status");
    }
  });

  it("shows the status dot for an interrupted session", () => {
    expect(
      sidebarDotKind({ status: "interrupted", updatedAt: T0, seenAt: null, isOpen: false }),
    ).toBe("status");
  });

  it("shows the unseen (blue) dot for a finished session never viewed", () => {
    expect(
      sidebarDotKind({ status: "completed", updatedAt: T0, seenAt: null, isOpen: false }),
    ).toBe("unseen");
    expect(sidebarDotKind({ status: "failed", updatedAt: T0, seenAt: null, isOpen: false })).toBe(
      "unseen",
    );
  });

  it("shows the unseen dot when the session finished after it was last viewed", () => {
    // viewed at T0, finished (updatedAt) at T1 → unseen
    expect(sidebarDotKind({ status: "completed", updatedAt: T1, seenAt: T0, isOpen: false })).toBe(
      "unseen",
    );
  });

  it("hides the dot once a finished session has been viewed after it finished", () => {
    // finished at T0, viewed at T1 → seen
    expect(sidebarDotKind({ status: "completed", updatedAt: T0, seenAt: T1, isOpen: false })).toBe(
      null,
    );
  });

  it("never marks the currently-open session as unseen", () => {
    expect(sidebarDotKind({ status: "completed", updatedAt: T1, seenAt: T0, isOpen: true })).toBe(
      null,
    );
  });

  it("shows nothing for idle non-terminal statuses", () => {
    for (const status of ["created", "ready", "archiving", "archived"]) {
      expect(sidebarDotKind({ status, updatedAt: T0, seenAt: null, isOpen: false })).toBe(null);
    }
  });
});
