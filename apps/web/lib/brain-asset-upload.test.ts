import { describe, expect, it, vi } from "vitest";
import {
  replaceHeadlessBrainAsset,
  uploadHeadlessBrainAsset,
  validateBrainAssetFile,
} from "./brain-asset-upload";

describe("canonical Brain asset client", () => {
  it("uploads multipart bytes without sending a Blob locator or client hash", async () => {
    let sent: Request | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      sent = input instanceof Request ? input : new Request(input, init);
      return Response.json(
        {
          data: { document: { id: "document_1" }, quotaPaused: false, replayed: false },
          meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
        },
        { status: 201 },
      );
    });
    const file = new File(["private"], "plan.pdf", { type: "application/pdf" });

    const result = await uploadHeadlessBrainAsset(
      { brainId: "brain_1", folderPath: "projects", file },
      {
        baseUrl: "https://api.example.test",
        fetch: fetchMock as typeof fetch,
        idempotencyKey: "upload-1",
      },
    );

    const request = sent as unknown as Request;
    expect(`${request.method} ${new URL(request.url).pathname}`).toBe(
      "POST /v1/brains/brain_1/assets",
    );
    expect(request.headers.get("idempotency-key")).toBe("upload-1");
    const form = await request.formData();
    expect([...form.keys()]).toEqual(["folderPath", "file"]);
    expect(form.get("folderPath")).toBe("projects");
    expect((form.get("file") as File).name).toBe("plan.pdf");
    expect(result).toMatchObject({ document: { id: "document_1" }, replayed: false });
  });

  it("replaces through the document-scoped operation and surfaces canonical request ids", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return Response.json(
        {
          error: {
            code: "conflict",
            message: "The asset changed.",
            requestId: "request_asset_1",
            retryable: false,
          },
          meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
        },
        { status: 409 },
      );
    });

    await expect(
      replaceHeadlessBrainAsset(
        {
          brainId: "brain_1",
          documentId: "document_1",
          file: new File(["replacement"], "plan.pdf", { type: "application/pdf" }),
        },
        { baseUrl: "https://api.example.test", fetch: fetchMock as typeof fetch },
      ),
    ).rejects.toThrow("The asset changed. (request request_asset_1)");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/v1/brains/brain_1/assets/document_1/replace",
    );
    expect(requests[0]?.headers.get("idempotency-key")).toMatch(/^web-brain-asset-replace:/u);
  });

  it("keeps fast client validation aligned with supported formats", () => {
    expect(
      validateBrainAssetFile(new File(["pdf"], "plan.pdf", { type: "application/pdf" })),
    ).toBeNull();
    expect(validateBrainAssetFile(new File([], "empty.pdf", { type: "application/pdf" }))).toBe(
      "That file is empty.",
    );
  });
});
