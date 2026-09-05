import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactViewer } from "./ArtifactViewer";

describe("ArtifactViewer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders Markdown and switches between immutable versions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/versions")) {
        return Response.json({
          data: {
            artifactId: "artifact_1",
            currentVersion: 2,
            versions: [
              {
                artifactVersionId: "version_2",
                version: 2,
                title: "Launch plan",
                description: "Punchier revision",
                filename: "launch-plan.md",
                mediaType: "text/markdown",
                sizeBytes: 18,
                createdAt: "2026-09-05T10:00:00.000Z",
              },
              {
                artifactVersionId: "version_1",
                version: 1,
                title: "Launch plan",
                filename: "launch-plan.md",
                mediaType: "text/markdown",
                sizeBytes: 12,
                createdAt: "2026-09-05T09:00:00.000Z",
              },
            ],
          },
        });
      }
      return new Response(url.endsWith("version_1") ? "# Original" : "# Punchier plan");
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

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
    const versionSelect = screen.getByRole("combobox", { name: "Artifact version" });
    await waitFor(() => expect(versionSelect).toBeEnabled());
    await user.selectOptions(versionSelect, "version_1");

    expect(await screen.findByRole("heading", { name: "Original" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Download Launch plan" })).toHaveAttribute(
      "href",
      "/v1/chat-artifacts/artifact_1/versions/version_1?download=1",
    );
  });
});
