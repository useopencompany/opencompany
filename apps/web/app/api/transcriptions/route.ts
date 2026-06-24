import { NextResponse } from "next/server";
import { currentWorkspace } from "@/lib/auth";

const TOGETHER_TRANSCRIPTIONS_URL = "https://api.together.xyz/v1/audio/transcriptions";
const TOGETHER_TRANSCRIPTION_MODEL = "nvidia/parakeet-tdt-0.6b-v3";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  await currentWorkspace();

  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Transcription is not configured." }, { status: 500 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!isUploadedAudio(file)) {
    return NextResponse.json({ error: "Audio file is required." }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "Audio file is too large." }, { status: 413 });
  }
  const upload = await readUploadedAudio(file);

  const providerForm = new FormData();
  providerForm.set("model", TOGETHER_TRANSCRIPTION_MODEL);
  providerForm.set("language", "auto");
  providerForm.set("response_format", "json");
  providerForm.set("file", new Blob([upload.bytes], { type: upload.type }), upload.name);

  const response = await fetch(TOGETHER_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: providerForm,
  });

  if (!response.ok) {
    return NextResponse.json({ error: "Transcription failed." }, { status: 502 });
  }

  const body = (await response.json()) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Transcription returned no text." }, { status: 502 });
  }

  return NextResponse.json({ text });
}

function isUploadedAudio(
  value: FormDataEntryValue | null,
): value is FormDataEntryValue & { arrayBuffer: () => Promise<ArrayBuffer>; size: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { size?: unknown }).size === "number" &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

async function readUploadedAudio(value: {
  arrayBuffer: () => Promise<ArrayBuffer>;
  name?: unknown;
  type?: unknown;
}): Promise<{
  bytes: ArrayBuffer;
  name: string;
  type: string;
}> {
  return {
    bytes: await value.arrayBuffer(),
    name: typeof value.name === "string" ? value.name : "voice-note.wav",
    type: typeof value.type === "string" ? value.type : "audio/wav",
  };
}
