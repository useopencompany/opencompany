import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactViewer } from "./ArtifactViewer";

describe("ArtifactViewer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders only the selected artifact content", async () => {
    const fetchMock = vi.fn(async () => new Response("# Punchier plan"));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ArtifactViewer
        selection={{
          artifact: {
            artifactId: "artifact_1",
            artifactVersionId: "version_2",
            version: 2,
            title: "Launch plan",
            description: "Punchier revision",
            filename: "launch-plan.md",
            mediaType: "text/markdown",
            sizeBytes: 18,
            state: "ready",
          },
          href: "/v1/chat-artifacts/artifact_1/versions/version_2",
        }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Punchier plan" })).toBeVisible();
    expect(screen.queryByText("Launch plan")).not.toBeInTheDocument();
    expect(screen.queryByText("launch-plan.md")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/chat-artifacts/artifact_1/versions/version_2",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
