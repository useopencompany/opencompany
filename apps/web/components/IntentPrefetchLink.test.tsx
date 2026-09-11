import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { IntentPrefetchLink } from "./IntentPrefetchLink";

const router = vi.hoisted(() => ({ prefetch: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({
  default: ({
    prefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch: boolean }) => (
    <a {...props} data-prefetch={String(prefetch)} />
  ),
}));

beforeEach(() => router.prefetch.mockClear());

it("disables viewport prefetch and warms a dynamic route once on intent", () => {
  const onIntent = vi.fn();
  render(
    <IntentPrefetchLink href="/workflows/test" onIntent={onIntent}>
      Test workflow
    </IntentPrefetchLink>,
  );

  const link = screen.getByRole("link", { name: "Test workflow" });
  expect(link).toHaveAttribute("data-prefetch", "false");
  expect(router.prefetch).not.toHaveBeenCalled();

  fireEvent.mouseEnter(link);
  fireEvent.focus(link);

  expect(router.prefetch).toHaveBeenCalledOnce();
  expect(router.prefetch).toHaveBeenCalledWith("/workflows/test");
  expect(onIntent).toHaveBeenCalledOnce();
});
