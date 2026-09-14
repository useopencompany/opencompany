import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatAttachments } from "./useChatAttachments";

function textFile(name: string) {
  return new File(["hello"], name, { type: "text/plain" });
}

function imageFile(name: string) {
  return new File(["png"], name, { type: "image/png" });
}

beforeEach(() => {
  let nextObjectUrl = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${(nextObjectUrl += 1)}`);
  URL.revokeObjectURL = vi.fn();
});

describe("useChatAttachments", () => {
  // The upload used to be started from inside a `setAttachments` updater, so React
  // replaying that updater uploaded the same file twice and leaked its preview URL.
  it("uploads each accepted file exactly once even when React replays renders", async () => {
    const upload = vi.fn(async () => ({ id: "stored" }));
    const { result } = renderHook(
      () =>
        useChatAttachments({
          modelName: "gpt-5.5",
          upload,
          capabilities: { images: true, pdf: true },
        }),
      { wrapper: StrictMode },
    );

    await act(async () => {
      result.current.acceptFiles([imageFile("shot.png")]);
    });

    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("ready"));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  // A fast upload resolving before its pending card was committed used to map over
  // state that did not contain the card yet, leaving it stuck on "uploading".
  it("marks an immediately resolved upload ready and keeps the server id", async () => {
    const upload = vi.fn(() => Promise.resolve({ id: "canonical-id", canonical: true }));
    const { result } = renderHook(() =>
      useChatAttachments({
        modelName: "gpt-5.5",
        upload,
        capabilities: { images: true, pdf: true },
      }),
    );

    await act(async () => {
      result.current.acceptFiles([textFile("notes.txt")]);
    });

    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(result.current.attachments[0]).toMatchObject({
      id: "canonical-id",
      filename: "notes.txt",
      status: "ready",
    });
    expect(result.current.isUploading).toBe(false);
  });

  it("keeps later files queued behind earlier ones when uploads settle out of order", async () => {
    const settle: Array<(value: { id: string }) => void> = [];
    const upload = vi.fn(() => new Promise<{ id: string }>((resolve) => settle.push(resolve)));
    const { result } = renderHook(() =>
      useChatAttachments({
        modelName: "gpt-5.5",
        upload,
        capabilities: { images: true, pdf: true },
      }),
    );

    await act(async () => {
      result.current.acceptFiles([textFile("first.txt"), textFile("second.txt")]);
    });
    await waitFor(() => expect(settle).toHaveLength(2));

    await act(async () => {
      settle[1]?.({ id: "second-id" });
    });
    await waitFor(() => expect(result.current.attachments[1]?.status).toBe("ready"));

    expect(result.current.attachments.map((attachment) => attachment.filename)).toEqual([
      "first.txt",
      "second.txt",
    ]);
    expect(result.current.attachments[0]?.status).toBe("uploading");
    expect(result.current.isUploading).toBe(true);

    await act(async () => {
      settle[0]?.({ id: "first-id" });
    });
    await waitFor(() => expect(result.current.isUploading).toBe(false));
    expect(result.current.attachments.map((attachment) => attachment.id)).toEqual([
      "first-id",
      "second-id",
    ]);
  });

  it("surfaces a rejected upload as an error without dropping its card", async () => {
    const upload = vi.fn(() => Promise.reject(new Error("upload refused")));
    const { result } = renderHook(() =>
      useChatAttachments({
        modelName: "gpt-5.5",
        upload,
        capabilities: { images: true, pdf: true },
      }),
    );

    await act(async () => {
      result.current.acceptFiles([textFile("broken.txt")]);
    });

    await waitFor(() => expect(result.current.hasFailed).toBe(true));
    expect(result.current.attachments[0]).toMatchObject({
      filename: "broken.txt",
      status: "error",
    });
  });

  it("revokes the preview URL of a removed image attachment", async () => {
    const upload = vi.fn(async () => ({ id: "stored" }));
    const { result } = renderHook(() =>
      useChatAttachments({
        modelName: "gpt-5.5",
        upload,
        capabilities: { images: true, pdf: true },
      }),
    );

    await act(async () => {
      result.current.acceptFiles([imageFile("shot.png")]);
    });
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    const previewUrl = result.current.attachments[0]?.previewUrl;

    act(() => result.current.removeAttachment(result.current.attachments[0]!.id));

    expect(result.current.attachments).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(previewUrl);
  });
});
