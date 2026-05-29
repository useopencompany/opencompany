/**
 * OC-161: All rendered markdown/MDX/changelog links must open in a new tab
 * with rel="noopener noreferrer".
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Changelog } from "@/lib/changelog";
import { getMDXComponents } from "@/mdx-components";
import ChangelogView from "./ChangelogView";

describe("OC-161 — links open in new tab", () => {
  describe("getMDXComponents (MDX/docs pages)", () => {
    it('renders <a> with target="_blank" and rel="noopener noreferrer"', () => {
      const components = getMDXComponents();
      const AnchorComponent = components.a as React.ComponentType<
        React.AnchorHTMLAttributes<HTMLAnchorElement> & { children?: React.ReactNode }
      >;
      const { container } = render(
        <AnchorComponent href="https://example.com">click me</AnchorComponent>,
      );
      const anchor = container.querySelector("a");
      expect(anchor).not.toBeNull();
      expect(anchor).toHaveAttribute("target", "_blank");
      expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    });
  });

  describe("ChangelogView (changelog links)", () => {
    const sampleChangelog: Changelog = {
      title: "Test Changelog",
      intro: [],
      releases: [
        {
          version: "1.0.0",
          notes: [],
          sections: [
            {
              category: "Added",
              items: ["See [the docs](https://example.com) for details"],
            },
          ],
        },
      ],
    };

    it('renders changelog links with target="_blank" and rel="noopener noreferrer"', async () => {
      render(<ChangelogView changelog={sampleChangelog} />);
      const anchor = await screen.findByRole("link", { name: "the docs" });
      expect(anchor).toHaveAttribute("target", "_blank");
      expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    });

    it('renders the release "Compare" link with target="_blank" and rel="noopener noreferrer"', async () => {
      const changelogWithCompare: Changelog = {
        title: "Test Changelog",
        intro: [],
        releases: [
          {
            version: "1.0.0",
            link: "https://example.com/compare/v0.9.0...v1.0.0",
            notes: [],
            sections: [],
          },
        ],
      };
      render(<ChangelogView changelog={changelogWithCompare} />);
      const anchor = await screen.findByRole("link", { name: /Compare/ });
      expect(anchor).toHaveAttribute("href", "https://example.com/compare/v0.9.0...v1.0.0");
      expect(anchor).toHaveAttribute("target", "_blank");
      expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    });
  });
});
