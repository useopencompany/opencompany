import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTree, type WikiPageData, WikiTreeSidebar } from "./WikiView";

const pages: WikiPageData[] = [
  {
    id: "folder-company",
    slug: "company",
    path: "company",
    title: "Company",
    nodeType: "folder",
    kind: "other",
    body: "",
  },
  {
    id: "page-goals",
    slug: "goals",
    path: "company/goals",
    title: "Goals",
    nodeType: "page",
    kind: "other",
    body: "",
  },
];

function renderSidebar() {
  return render(
    <WikiTreeSidebar
      nodes={buildTree(pages)}
      expansionStorageScope={{ userWorkosId: "user-1", workspaceId: "workspace-1" }}
      selectedPath={null}
      onSelect={vi.fn()}
      onCreate={() => null}
      onRename={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe("WikiTreeSidebar", () => {
  beforeEach(() => window.localStorage.clear());

  it("starts collapsed and remembers an expanded folder after remounting", () => {
    const firstRender = renderSidebar();
    expect(screen.queryByText("Goals")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByText("Goals")).toBeTruthy();

    firstRender.unmount();
    const secondRender = renderSidebar();
    expect(screen.getByText("Goals")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.queryByText("Goals")).toBeNull();

    secondRender.unmount();
    renderSidebar();
    expect(screen.queryByText("Goals")).toBeNull();
  });

  it("keeps expansion preferences separate between users", () => {
    window.localStorage.setItem(
      "opencompany-wiki-tree-expanded:v1:user-2:workspace-1",
      JSON.stringify(["folder-company"]),
    );

    renderSidebar();
    expect(screen.queryByText("Goals")).toBeNull();
  });
});
