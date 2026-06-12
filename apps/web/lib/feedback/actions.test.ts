import { getDb } from "@opencompany/db/client";
import { del, get } from "@vercel/blob";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentWorkspace } from "@/lib/auth";
import { submitFeedback } from "./actions";

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  get: vi.fn(),
  del: vi.fn(),
}));

const currentWorkspaceMock = vi.mocked(currentWorkspace);
const getDbMock = vi.mocked(getDb);
const getMock = vi.mocked(get);
const delMock = vi.mocked(del);

// A fresh single-chunk readable each call (a ReadableStream is consumed once).
function blobStream(bytes = new Uint8Array([137, 80, 78, 71])) {
  return {
    statusCode: 200,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  } as unknown as Awaited<ReturnType<typeof get>>;
}

function fileUploadResponse() {
  return linearResponse({
    fileUpload: {
      success: true,
      uploadFile: {
        uploadUrl: "https://upload.linear.app/signed",
        assetUrl: "https://uploads.linear.app/abc/shot.png",
        headers: [{ key: "x-amz-meta-test", value: "1" }],
      },
    },
  });
}

function putOkResponse() {
  return { ok: true, status: 200 } as Response;
}

const FEEDBACK_BLOB_URL =
  "https://store123.blob.vercel-storage.com/workspace/wks_123/feedback/img1-shot.png";

function imageField(overrides: Partial<Record<string, string>> = {}) {
  return JSON.stringify({
    blobPathname: "workspace/wks_123/feedback/img1-shot.png",
    blobUrl: FEEDBACK_BLOB_URL,
    filename: "shot.png",
    mediaType: "image/png",
    ...overrides,
  });
}

function mockSessionLookup(rows: Array<{ id: string }>) {
  const builder = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    limit: vi.fn(() => Promise.resolve(rows)),
  };

  getDbMock.mockReturnValue({
    select: vi.fn(() => builder),
  } as unknown as ReturnType<typeof getDb>);
}

function linearResponse(data: unknown) {
  return {
    ok: true,
    json: async () => ({ data }),
  } as Response;
}

function labelsResponse() {
  return linearResponse({
    team: {
      labels: {
        nodes: [
          { id: "lbl_feedback", name: "feedback" },
          { id: "lbl_source_app", name: "source:app" },
          { id: "lbl_bug", name: "bug" },
        ],
      },
    },
  });
}

function issueCreateResponse() {
  return linearResponse({
    issueCreate: {
      success: true,
      issue: { id: "lin_123", identifier: "FEED-123" },
    },
  });
}

function issueCreateInput() {
  const issueCall = vi.mocked(fetch).mock.calls.at(-1);
  expect(issueCall).toBeDefined();
  const body = JSON.parse(String(issueCall?.[1]?.body)) as {
    variables: { input: { description: string } };
  };

  return body.variables.input;
}

describe("submitFeedback", () => {
  beforeEach(() => {
    process.env.LINEAR_API_KEY = "lin_test";
    process.env.LINEAR_TEAM_ID = "team_123";
    delete process.env.LINEAR_FEEDBACK_PROJECT_ID;
    delete process.env.LINEAR_FEEDBACK_LABELS;

    currentWorkspaceMock.mockResolvedValue({
      authUser: {
        id: "workos_123",
        email: "lee@example.com",
        firstName: "Lee",
        lastName: "Chen",
      },
      user: { id: "usr_123" },
      workspace: { id: "wks_123", name: "Acme" },
      role: "member",
      isNewUser: false,
    } as Awaited<ReturnType<typeof currentWorkspace>>);

    getMock.mockImplementation(async () => blobStream());
    delMock.mockResolvedValue(undefined as never);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(labelsResponse()));
  });

  it("includes the verified session id in the Linear issue description", async () => {
    mockSessionLookup([{ id: "ses_123" }]);
    vi.mocked(fetch).mockResolvedValueOnce(issueCreateResponse());

    const formData = new FormData();
    formData.set("kind", "bug");
    formData.set("message", "The session froze.");
    formData.set("sessionId", "ses_123");

    await expect(submitFeedback(null, formData)).resolves.toEqual({ ok: true });

    expect(issueCreateInput().description).toContain("Session ID: ses_123");
  });

  it("omits an unverified session id from the Linear issue description", async () => {
    mockSessionLookup([]);
    vi.mocked(fetch).mockResolvedValueOnce(issueCreateResponse());

    const formData = new FormData();
    formData.set("kind", "bug");
    formData.set("message", "The session froze.");
    formData.set("sessionId", "ses_other");

    await expect(submitFeedback(null, formData)).resolves.toEqual({ ok: true });

    expect(issueCreateInput().description).not.toContain("Session ID:");
  });

  it("uploads an attached screenshot to Linear and embeds it inline in the description", async () => {
    mockSessionLookup([]);
    // fetch order with one image: fileUpload, PUT, labels, issueCreate.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(fileUploadResponse())
        .mockResolvedValueOnce(putOkResponse())
        .mockResolvedValueOnce(labelsResponse())
        .mockResolvedValueOnce(issueCreateResponse()),
    );

    const formData = new FormData();
    formData.set("kind", "bug");
    formData.set("message", "Button overlaps the header.");
    formData.append("images", imageField());

    await expect(submitFeedback(null, formData)).resolves.toEqual({ ok: true });

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(issueCreateInput().description).toContain(
      "![shot.png](https://uploads.linear.app/abc/shot.png)",
    );
    // The transit blob is cleaned up once the image lives in Linear.
    expect(delMock).toHaveBeenCalledWith(FEEDBACK_BLOB_URL);
  });

  it("ignores an image whose blob path is outside the caller's workspace", async () => {
    mockSessionLookup([]);
    vi.mocked(fetch).mockResolvedValueOnce(issueCreateResponse());

    const formData = new FormData();
    formData.set("kind", "bug");
    formData.set("message", "Something broke.");
    formData.append(
      "images",
      imageField({
        blobUrl:
          "https://store123.blob.vercel-storage.com/workspace/wks_other/feedback/img1-shot.png",
      }),
    );

    await expect(submitFeedback(null, formData)).resolves.toEqual({ ok: true });

    // Rejected before any blob read or upload — never touched.
    expect(getMock).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
    expect(issueCreateInput().description).not.toContain("![");
  });

  it("ignores an image whose blob url is not a Vercel Blob host", async () => {
    mockSessionLookup([]);
    vi.mocked(fetch).mockResolvedValueOnce(issueCreateResponse());

    const formData = new FormData();
    formData.set("kind", "bug");
    formData.set("message", "Something broke.");
    formData.append(
      "images",
      // A valid-looking path on an attacker-controlled host must not be read with the store token.
      imageField({ blobUrl: "https://evil.example.com/workspace/wks_123/feedback/img1-shot.png" }),
    );

    await expect(submitFeedback(null, formData)).resolves.toEqual({ ok: true });

    expect(getMock).not.toHaveBeenCalled();
    expect(issueCreateInput().description).not.toContain("![");
  });

  it("still files the issue when a screenshot upload fails", async () => {
    mockSessionLookup([]);
    getMock.mockRejectedValueOnce(new Error("blob unavailable"));
    // No fileUpload/PUT fetch happens (blob read fails first): labels, issueCreate.
    vi.mocked(fetch).mockResolvedValueOnce(issueCreateResponse());

    const formData = new FormData();
    formData.set("kind", "bug");
    formData.set("message", "Crash on save.");
    formData.append("images", imageField());

    await expect(submitFeedback(null, formData)).resolves.toEqual({ ok: true });

    const description = issueCreateInput().description;
    expect(description).not.toContain("![");
    expect(description).toContain("1 screenshot could not be attached.");
  });
});
