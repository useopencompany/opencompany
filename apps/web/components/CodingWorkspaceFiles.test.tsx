import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CodingWorkspaceFiles from "./CodingWorkspaceFiles";

// The real editor is CodeMirror, which needs layout jsdom does not provide. This stand-in
// keeps the contract the panel depends on: initial text in, edits and saves out.
vi.mock("./CodingWorkspaceCodeEditor", () => ({
  default: ({
    path,
    initialContent,
    readOnly,
    onChange,
    onSave,
  }: {
    path: string;
    initialContent: string;
    readOnly: boolean;
    onChange: (content: string) => void;
    onSave: () => void;
  }) => (
    <div>
      <textarea
        aria-label={`Edit ${path}`}
        defaultValue={initialContent}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="button" onClick={onSave}>
        Save from editor
      </button>
    </div>
  ),
}));

class FakeSocket extends EventTarget {
  readyState = 1;
  send = vi.fn();

  receive(payload: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  sentMessages() {
    return this.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
  }
}

const ROOT_LISTING = {
  type: "files.listing",
  path: "",
  truncated: false,
  entries: [
    { name: "apps", path: "apps", type: "directory", size: 0, symlink: false },
    { name: "README.md", path: "README.md", type: "file", size: 12, symlink: false },
    { name: "logo.png", path: "logo.png", type: "file", size: 3, symlink: false },
  ],
};

function renderFiles(socket: FakeSocket) {
  return render(
    <CodingWorkspaceFiles
      socket={socket as unknown as WebSocket}
      sessionKey="session_1"
      rootLabel="Claude Code"
      active
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("CodingWorkspaceFiles", () => {
  it("lists the workspace root and expands a folder only when it is opened", async () => {
    const user = userEvent.setup();
    const socket = new FakeSocket();
    renderFiles(socket);

    expect(socket.sentMessages()).toEqual([{ type: "files.list", path: "" }]);
    socket.receive(ROOT_LISTING);

    expect(await screen.findByRole("treeitem", { name: /README\.md/ })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /apps/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await user.click(screen.getByRole("treeitem", { name: /apps/ }));
    expect(socket.sentMessages()).toContainEqual({ type: "files.list", path: "apps" });
    socket.receive({
      type: "files.listing",
      path: "apps",
      truncated: false,
      entries: [{ name: "web", path: "apps/web", type: "directory", size: 0, symlink: false }],
    });

    expect(await screen.findByRole("treeitem", { name: /web/ })).toHaveAttribute("aria-level", "2");
    expect(screen.getByRole("treeitem", { name: /apps/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("opens a file, tracks unsaved changes, and saves against the revision it read", async () => {
    const user = userEvent.setup();
    const socket = new FakeSocket();
    renderFiles(socket);
    socket.receive(ROOT_LISTING);

    await user.click(await screen.findByRole("treeitem", { name: /README\.md/ }));
    expect(socket.sentMessages()).toContainEqual({ type: "files.open", path: "README.md" });

    socket.receive({
      type: "files.content",
      path: "README.md",
      kind: "text",
      content: "# hello",
      revision: "rev-1",
      size: 7,
      editable: true,
    });

    const editor = await screen.findByLabelText("Edit README.md");
    expect(editor).toHaveValue("# hello");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(editor, "!");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(
      within(screen.getByRole("treeitem", { name: /README\.md/ })).getByTitle("Unsaved changes"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(socket.sentMessages()).toContainEqual({
      type: "files.save",
      path: "README.md",
      content: "# hello!",
      baseRevision: "rev-1",
    });

    socket.receive({ type: "files.saved", path: "README.md", revision: "rev-2", size: 8 });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  });

  it("offers a reload or an overwrite when the workspace changed the file first", async () => {
    const user = userEvent.setup();
    const socket = new FakeSocket();
    renderFiles(socket);
    socket.receive(ROOT_LISTING);

    await user.click(await screen.findByRole("treeitem", { name: /README\.md/ }));
    socket.receive({
      type: "files.content",
      path: "README.md",
      kind: "text",
      content: "# hello",
      revision: "rev-1",
      size: 7,
      editable: true,
    });
    await user.type(await screen.findByLabelText("Edit README.md"), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));

    socket.receive({
      type: "files.error",
      scope: "save",
      path: "README.md",
      code: "conflict",
      message: "This file changed in the workspace after you opened it.",
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file changed in the workspace after you opened it.",
    );

    await user.click(screen.getByRole("button", { name: "Save anyway" }));
    expect(socket.sentMessages()).toContainEqual({
      type: "files.save",
      path: "README.md",
      content: "# hello!",
      baseRevision: null,
    });
  });

  it("keeps an unsaved edit when another file is opened and returned to", async () => {
    const user = userEvent.setup();
    const socket = new FakeSocket();
    renderFiles(socket);
    socket.receive(ROOT_LISTING);

    await user.click(await screen.findByRole("treeitem", { name: /README\.md/ }));
    socket.receive({
      type: "files.content",
      path: "README.md",
      kind: "text",
      content: "# hello",
      revision: "rev-1",
      size: 7,
      editable: true,
    });
    await user.type(await screen.findByLabelText("Edit README.md"), "!");

    await user.click(screen.getByRole("treeitem", { name: /logo\.png/ }));
    socket.receive({
      type: "files.content",
      path: "logo.png",
      kind: "image",
      dataUrl: "data:image/png;base64,AQID",
      size: 3,
    });
    expect(await screen.findByAltText("logo.png")).toBeInTheDocument();

    await user.click(screen.getByRole("treeitem", { name: /README\.md/ }));
    expect(await screen.findByLabelText("Edit README.md")).toHaveValue("# hello!");
    // Reopening from the in-memory buffer must not cost another sandbox round trip.
    expect(socket.sentMessages().filter((message) => message.type === "files.open").length).toBe(2);
  });

  it("baselines a save on the text it sent, leaving keystrokes from mid-save dirty", async () => {
    const user = userEvent.setup();
    const socket = new FakeSocket();
    renderFiles(socket);
    socket.receive(ROOT_LISTING);

    await user.click(await screen.findByRole("treeitem", { name: /README\.md/ }));
    socket.receive({
      type: "files.content",
      path: "README.md",
      kind: "text",
      content: "# hello",
      revision: "rev-1",
      size: 7,
      editable: true,
    });

    const editor = await screen.findByLabelText("Edit README.md");
    await user.type(editor, "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // A keystroke lands while the save is still in flight.
    await user.type(editor, "?");
    socket.receive({ type: "files.saved", path: "README.md", revision: "rev-2", size: 8 });

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(socket.sentMessages()).toContainEqual({
      type: "files.save",
      path: "README.md",
      content: "# hello!?",
      baseRevision: "rev-2",
    });
  });

  it("applies a save that lands after the user moved to another file", async () => {
    const user = userEvent.setup();
    const socket = new FakeSocket();
    renderFiles(socket);
    socket.receive(ROOT_LISTING);

    await user.click(await screen.findByRole("treeitem", { name: /README\.md/ }));
    socket.receive({
      type: "files.content",
      path: "README.md",
      kind: "text",
      content: "# hello",
      revision: "rev-1",
      size: 7,
      editable: true,
    });
    await user.type(await screen.findByLabelText("Edit README.md"), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await user.click(screen.getByRole("treeitem", { name: /logo\.png/ }));
    socket.receive({ type: "files.saved", path: "README.md", revision: "rev-2", size: 8 });
    socket.receive({
      type: "files.content",
      path: "logo.png",
      kind: "image",
      dataUrl: "data:image/png;base64,AQID",
      size: 3,
    });
    await screen.findByAltText("logo.png");

    await user.click(screen.getByRole("treeitem", { name: /README\.md/ }));
    const editor = await screen.findByLabelText("Edit README.md");
    expect(editor).toHaveValue("# hello!");
    expect(
      within(screen.getByRole("treeitem", { name: /README\.md/ })).queryByTitle("Unsaved changes"),
    ).not.toBeInTheDocument();

    // The revision the save returned is what the next edit builds on; without it the
    // workspace would report a conflict against the user's own write.
    await user.type(editor, "?");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(socket.sentMessages()).toContainEqual({
      type: "files.save",
      path: "README.md",
      content: "# hello!?",
      baseRevision: "rev-2",
    });
  });

  it("navigates the tree with the keyboard", async () => {
    const user = userEvent.setup();
    const socket = new FakeSocket();
    renderFiles(socket);
    socket.receive(ROOT_LISTING);

    const folder = await screen.findByRole("treeitem", { name: /apps/ });
    folder.focus();
    await user.keyboard("{ArrowRight}");
    expect(socket.sentMessages()).toContainEqual({ type: "files.list", path: "apps" });

    await user.keyboard("{ArrowLeft}");
    expect(folder).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{ArrowDown}{Enter}");
    expect(socket.sentMessages()).toContainEqual({ type: "files.open", path: "README.md" });
  });

  it("restores the remembered folders and file for the session", async () => {
    window.localStorage.setItem(
      "goat-coding-workspace-files-layout-v1:session_1",
      JSON.stringify({ expandedPaths: ["apps"], selectedPath: "README.md", treeVisible: true }),
    );
    const socket = new FakeSocket();
    renderFiles(socket);

    expect(socket.sentMessages()).toEqual([
      { type: "files.list", path: "" },
      { type: "files.list", path: "apps" },
      { type: "files.open", path: "README.md" },
    ]);
    expect(await screen.findByText("Opening file…")).toBeInTheDocument();
  });

  it("explains files it cannot edit instead of showing an empty editor", async () => {
    const user = userEvent.setup();
    const socket = new FakeSocket();
    renderFiles(socket);
    socket.receive(ROOT_LISTING);

    await user.click(await screen.findByRole("treeitem", { name: /README\.md/ }));
    socket.receive({
      type: "files.content",
      path: "README.md",
      kind: "too_large",
      size: 4_194_304,
    });

    expect(await screen.findByText("Too large to open here")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});
