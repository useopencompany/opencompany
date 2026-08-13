import {
  claimDueGoatOnboardingEmails,
  enrollGoatOnboardingEmails,
  failGoatOnboardingEmail,
  markGoatOnboardingEmailSent,
  rescheduleGoatOnboardingEmail,
  skipPendingGoatOnboardingEmailsForEmail,
} from "@opencompany/db/goat-onboarding-emails";
import { listGoatWorkspacesForUser } from "@opencompany/db/goat-workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOnboardingEmailService } from "./onboarding-emails";

vi.mock("@opencompany/db/goat-onboarding-emails", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  claimDueGoatOnboardingEmails: vi.fn(),
  enrollGoatOnboardingEmails: vi.fn(async () => undefined),
  failGoatOnboardingEmail: vi.fn(async () => undefined),
  markGoatOnboardingEmailSent: vi.fn(async () => undefined),
  rescheduleGoatOnboardingEmail: vi.fn(async () => undefined),
  skipPendingGoatOnboardingEmailsForEmail: vi.fn(async () => 0),
}));

vi.mock("@opencompany/db/goat-workspaces", () => ({
  listGoatWorkspacesForUser: vi.fn(),
}));

describe("onboarding email persistence service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimDueGoatOnboardingEmails).mockResolvedValue([]);
    vi.mocked(listGoatWorkspacesForUser).mockResolvedValue([
      { workspace: { createdByWorkosId: "user_1" }, role: "admin" },
    ] as never);
  });

  it("rejects enrollment for a caller who does not own an accessible workspace", async () => {
    vi.mocked(listGoatWorkspacesForUser).mockResolvedValueOnce([
      { workspace: { createdByWorkosId: "user_2" }, role: "member" },
    ] as never);
    const service = createOnboardingEmailService({ db: {} });
    await expect(service.enroll("user_1")).rejects.toMatchObject({ status: 403 });
    expect(enrollGoatOnboardingEmails).not.toHaveBeenCalled();
  });

  it("enrolls only the verified identity and claims with an optional owner scope", async () => {
    const db = {};
    const service = createOnboardingEmailService({ db });
    await service.enroll("user_1");
    expect(enrollGoatOnboardingEmails).toHaveBeenCalledWith({ workosUserId: "user_1" }, { db });

    vi.mocked(claimDueGoatOnboardingEmails).mockResolvedValueOnce([
      {
        id: "goem_1",
        workosUserId: "user_1",
        step: "welcome",
        attempts: 6,
        email: "owner@example.com",
        firstName: "Owner",
      },
    ]);
    await expect(service.claimDue(4, "user_1")).resolves.toEqual([
      expect.objectContaining({ id: "goem_1", terminalOnFailure: true }),
    ]);
    expect(claimDueGoatOnboardingEmails).toHaveBeenCalledWith(
      { limit: 4, workosUserId: "user_1" },
      { db },
    );
  });

  it("maps delivery outcomes to the durable queue operations", async () => {
    const db = {};
    const service = createOnboardingEmailService({ db });
    await service.settle({ id: "goem_sent", outcome: "sent" });
    expect(markGoatOnboardingEmailSent).toHaveBeenCalledWith("goem_sent", { db });

    await service.settle({ id: "goem_failed", outcome: "failed", error: "rejected" });
    expect(failGoatOnboardingEmail).toHaveBeenCalledWith(
      { id: "goem_failed", error: "rejected" },
      { db },
    );

    const nextRunAt = new Date("2026-08-13T19:00:00.000Z");
    await service.settle({
      id: "goem_retry",
      outcome: "rescheduled",
      error: "timeout",
      nextRunAt,
    });
    expect(rescheduleGoatOnboardingEmail).toHaveBeenCalledWith(
      { id: "goem_retry", error: "timeout", nextRunAt },
      { db },
    );
  });

  it("unsubscribes by normalized email through the injected database", async () => {
    const db = {};
    vi.mocked(skipPendingGoatOnboardingEmailsForEmail).mockResolvedValueOnce(2);
    const service = createOnboardingEmailService({ db });
    await expect(service.unsubscribe("owner@example.com")).resolves.toBe(2);
    expect(skipPendingGoatOnboardingEmailsForEmail).toHaveBeenCalledWith("owner@example.com", {
      db,
    });
  });
});
