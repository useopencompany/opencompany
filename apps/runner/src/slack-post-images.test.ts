import { describe, expect, it, vi } from "vitest";
import {
  isSlackFileNotReady,
  slackImageLinkText,
  slackPostBlocks,
  uploadSlackPostImages,
} from "./slack-post-images";

describe("uploadSlackPostImages", () => {
  it("uploads each image privately and completes them together without sharing to a channel", async () => {
    let next = 0;
    const request = vi.fn(async ({ method }: { method: string }) =>
      method === "files.getUploadURLExternal"
        ? { upload_url: `https://files.slack.com/upload/${++next}`, file_id: `F${next}` }
        : {},
    );
    const upload = vi.fn(async () => new Response("OK"));
    const download = vi.fn(async (pathname: string) => Buffer.from(pathname));

    const uploaded = await uploadSlackPostImages(
      {
        token: "xoxb-test",
        images: [
          { title: "Welcome", filename: "welcome.png", blobPathname: "blob/welcome.png" },
          { title: "Connect", filename: "connect.png", blobPathname: "blob/connect.png" },
        ],
      },
      {
        request: request as never,
        download,
        fetch: upload as unknown as typeof fetch,
      },
    );

    expect(uploaded).toEqual([
      { fileId: "F1", title: "Welcome" },
      { fileId: "F2", title: "Connect" },
    ]);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "files.getUploadURLExternal",
        form: { filename: "welcome.png", length: String("blob/welcome.png".length) },
      }),
    );
    expect(upload).toHaveBeenCalledWith(
      "https://files.slack.com/upload/2",
      expect.objectContaining({ method: "POST" }),
    );
    const complete = request.mock.calls.at(-1)?.[0] as { method: string; form: object };
    expect(complete.method).toBe("files.completeUploadExternal");
    // No channel: the post that references the files is what shows them.
    expect(complete.form).toEqual({
      files: JSON.stringify([
        { id: "F1", title: "Welcome" },
        { id: "F2", title: "Connect" },
      ]),
    });
  });

  it("fails before completing anything when Slack rejects the bytes", async () => {
    const request = vi.fn(async () => ({
      upload_url: "https://files.slack.com/upload/1",
      file_id: "F1",
    }));
    await expect(
      uploadSlackPostImages(
        {
          token: "xoxb-test",
          images: [{ title: "Welcome", filename: "welcome.png", blobPathname: "blob/welcome.png" }],
        },
        {
          request: request as never,
          download: async () => Buffer.from("png"),
          fetch: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow("Slack image upload failed with 500.");
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "files.completeUploadExternal" }),
    );
  });
});

describe("slackPostBlocks", () => {
  it("keeps long text whole across sections, then adds each image in order", () => {
    const text = "a".repeat(3200);
    const blocks = slackPostBlocks(text, [{ fileId: "F1", title: "Chart" }]);
    expect(blocks.map((block) => block.type)).toEqual(["section", "section", "image"]);
    expect(
      blocks
        .filter((block) => block.type === "section")
        .map((block) => (block as { text: { text: string } }).text.text)
        .join(""),
    ).toBe(text);
    expect(blocks[2]).toEqual({
      type: "image",
      slack_file: { id: "F1" },
      alt_text: "Chart",
      title: { type: "plain_text", text: "Chart" },
    });
  });
});

describe("slackPostBlocks text splitting", () => {
  const sections = (text: string) =>
    slackPostBlocks(text, [])
      .filter((block) => block.type === "section")
      .map((block) => (block as { text: { text: string } }).text.text);

  it("breaks at a word boundary instead of mid-word", () => {
    const text = `${"word ".repeat(700)}tail`;
    const [first, second] = sections(text);
    expect(first?.length).toBeLessThanOrEqual(3000);
    expect(first?.endsWith("word")).toBe(true);
    expect(`${first} ${second}`).toBe(text);
  });

  it("never splits a Slack link or an emoji across sections", () => {
    const link = "<https://app.example.com/tasks/t1|See the task>";
    const linked = sections(`${"a".repeat(2990)}${link}`);
    expect(linked).toEqual(["a".repeat(2990), link]);

    const emoji = sections(`${"a".repeat(2999)}😀${"b".repeat(10)}`);
    expect(emoji[0]).toBe("a".repeat(2999));
    expect(emoji[1]?.startsWith("😀")).toBe(true);
  });
});

describe("image fallbacks", () => {
  it("only treats Slack's block rejection as a file that is still processing", () => {
    expect(
      isSlackFileNotReady(new Error("Slack API chat.postMessage returned invalid_blocks.")),
    ).toBe(true);
    expect(
      isSlackFileNotReady(new Error("Slack API chat.postMessage returned not_in_channel.")),
    ).toBe(false);
  });

  it("links to the task, or names it when no link is available", () => {
    expect(slackImageLinkText("Done.", "https://app.example.com/tasks/t1")).toBe(
      "Done.\n\n<https://app.example.com/tasks/t1|See the images in opencompany>",
    );
    expect(slackImageLinkText("Done.", null)).toBe(
      "Done.\n\n_The images are in the opencompany task._",
    );
  });
});
