import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingIndicator } from "./ThinkingIndicator";

describe("ThinkingIndicator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the server-rendered timer stable across wall-clock changes", () => {
    vi.useFakeTimers();
    const startedAtMs = Date.UTC(2026, 8, 19, 8, 0, 0);

    vi.setSystemTime(startedAtMs + 1_000);
    const firstRender = renderToString(<ThinkingIndicator startedAtMs={startedAtMs} />);

    vi.setSystemTime(startedAtMs + 5_000);
    const secondRender = renderToString(<ThinkingIndicator startedAtMs={startedAtMs} />);

    expect(firstRender).toBe(secondRender);
    expect(firstRender).toContain(">0.0s<");
  });
});
