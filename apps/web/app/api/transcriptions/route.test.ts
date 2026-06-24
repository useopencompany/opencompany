import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentWorkspace } from "@/lib/auth";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

const currentWorkspaceMock = vi.mocked(currentWorkspace);

function makeRequest(file?: File) {
  const form = new FormData();
  if (file) form.set("file", file);
  return new Request("http://localhost/api/transcriptions", {
    method: "POST",
    body: form,
  });
}

describe("transcriptions API route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("TOGETHER_API_KEY", "tog_test_key");
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
  });

  it("requires an authenticated workspace before transcribing", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    currentWorkspaceMock.mockRejectedValue(redirect);

    await expect(
      POST(makeRequest(new File(["wav"], "voice.wav", { type: "audio/wav" }))),
    ).rejects.toThrow("NEXT_REDIRECT");
  });

  it("rejects requests without an audio file", async () => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Audio file is required." });
  });

  it("fails fast when transcription is not configured", async () => {
    vi.stubEnv("TOGETHER_API_KEY", "");
    const response = await POST({
      formData: vi.fn(),
    } as unknown as Request);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Transcription is not configured.",
    });
  });

  it("rejects audio files over 10 MB", async () => {
    const oversized = {
      size: 10 * 1024 * 1024 + 1,
      arrayBuffer: vi.fn(),
    };
    const response = await POST({
      formData: async () => ({ get: () => oversized }),
    } as unknown as Request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Audio file is too large." });
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
  });

  it("forwards the audio to Together Parakeet and returns transcript text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "Ship the voice feature." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(makeRequest(new File(["wav"], "voice.wav", { type: "audio/wav" })));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "Ship the voice feature." });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.together.xyz/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer tog_test_key" },
        body: expect.any(FormData),
      }),
    );
    const providerForm = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(providerForm.get("model")).toBe("nvidia/parakeet-tdt-0.6b-v3");
    expect(providerForm.get("language")).toBe("auto");
    expect(providerForm.get("response_format")).toBe("json");
    expect(providerForm.get("file")).toBeInstanceOf(File);
  });

  it("maps provider failures to a bad gateway response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })),
    );

    const response = await POST(makeRequest(new File(["wav"], "voice.wav", { type: "audio/wav" })));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Transcription failed." });
  });
});
