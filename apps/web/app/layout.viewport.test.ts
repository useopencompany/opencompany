import { describe, expect, it, vi } from "vitest";

// layout.tsx imports the WorkOS AuthKitProvider, which transitively imports
// `next/cache` (server-only) and fails to resolve under vitest/jsdom. Mock the
// provider so we can import the module and assert its `viewport` export.
vi.mock("@workos-inc/authkit-nextjs/components", () => ({
  AuthKitProvider: (props: { children?: unknown }) => props.children,
}));

import { viewport } from "./layout";

describe("root viewport", () => {
  it("locks scale to prevent iOS focus-zoom and covers safe areas", () => {
    expect(viewport.width).toBe("device-width");
    expect(viewport.initialScale).toBe(1);
    expect(viewport.maximumScale).toBe(1);
    expect(viewport.viewportFit).toBe("cover");
  });
});
