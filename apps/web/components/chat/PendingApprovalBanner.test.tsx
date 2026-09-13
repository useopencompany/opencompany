import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "./approval-presentation";
import {
  APPROVAL_CARD_ID_ATTRIBUTE,
  APPROVAL_PRIMARY_BUTTON_ATTRIBUTE,
  PendingApprovalBanner,
} from "./PendingApprovalBanner";

// jsdom has no intersection observer, so the test drives visibility the way a scroll would.
const observers: Array<{
  callback: IntersectionObserverCallback;
  targets: Element[];
}> = [];

function reportVisibility(visibility: Record<string, boolean>) {
  for (const observer of observers) {
    const records = observer.targets
      .filter((target) => {
        const id = target.getAttribute(APPROVAL_CARD_ID_ATTRIBUTE);
        return id !== null && id in visibility;
      })
      .map((target) => ({
        target,
        isIntersecting: visibility[target.getAttribute(APPROVAL_CARD_ID_ATTRIBUTE) ?? ""] === true,
      }));
    if (records.length > 0) {
      act(() => {
        observer.callback(records as unknown as IntersectionObserverEntry[], {} as never);
      });
    }
  }
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      targets: Element[] = [];
      constructor(callback: IntersectionObserverCallback) {
        observers.push({ callback, targets: this.targets });
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      disconnect() {
        this.targets.length = 0;
      }
      unobserve() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderThread(approvals: PendingApproval[]) {
  const threadRef = createRef<HTMLDivElement>();
  const scrollIntoView = vi.fn();
  const view = render(
    <>
      <div ref={threadRef}>
        {approvals.map((approval) => (
          <div key={approval.approvalId} {...{ [APPROVAL_CARD_ID_ATTRIBUTE]: approval.approvalId }}>
            <button type="button" {...{ [APPROVAL_PRIMARY_BUTTON_ATTRIBUTE]: "" }}>
              Allow once for {approval.approvalId}
            </button>
          </div>
        ))}
      </div>
      <PendingApprovalBanner approvals={approvals} threadRef={threadRef} />
    </>,
  );
  for (const card of view.container.querySelectorAll(`[${APPROVAL_CARD_ID_ATTRIBUTE}]`)) {
    (card as HTMLElement).scrollIntoView = scrollIntoView;
  }
  return { scrollIntoView };
}

const terminalApproval: PendingApproval = {
  approvalId: "approval_1",
  source: "Terminal",
  question: "Run this command?",
};
const linearApproval: PendingApproval = {
  approvalId: "approval_2",
  source: "Linear",
  question: "Run create issue in Linear?",
};

describe("pending approval banner", () => {
  it("stays out of the way while the decision is on screen", () => {
    renderThread([terminalApproval]);
    reportVisibility({ approval_1: true });
    expect(screen.queryByTestId("chat-pending-approval-banner")).not.toBeInTheDocument();
  });

  it("names the decision that scrolled away and carries the user back to it", async () => {
    const user = userEvent.setup();
    const { scrollIntoView } = renderThread([terminalApproval]);
    reportVisibility({ approval_1: false });

    expect(screen.getByTestId("chat-pending-approval-banner")).toHaveTextContent(
      "Terminal · Run this command?",
    );
    await user.click(screen.getByTestId("chat-pending-approval-banner"));
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Allow once for approval_1" })).toHaveFocus();
  });

  it("counts the decisions still waiting when more than one is out of view", () => {
    renderThread([terminalApproval, linearApproval]);
    reportVisibility({ approval_1: false, approval_2: false });
    expect(screen.getByTestId("chat-pending-approval-banner")).toHaveTextContent(
      "2 approvals are waiting for you",
    );

    reportVisibility({ approval_1: true });
    expect(screen.getByTestId("chat-pending-approval-banner")).toHaveTextContent(
      "Linear · Run create issue in Linear?",
    );
  });

  it("disappears once the approval is resolved and its card unmounts", () => {
    renderThread([]);
    expect(screen.queryByTestId("chat-pending-approval-banner")).not.toBeInTheDocument();
  });
});
