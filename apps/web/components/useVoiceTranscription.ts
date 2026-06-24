"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ToastProvider";

type VoiceTranscriptionStatus = "idle" | "recording" | "transcribing";

type VoiceTranscriptionOptions = {
  onTranscription: (text: string) => void;
};

export function useVoiceTranscription({ onTranscription }: VoiceTranscriptionOptions) {
  const { showToast } = useToast();
  const [status, setStatus] = useState<VoiceTranscriptionStatus>("idle");
  const isSupported = canRecordAudio();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mountedRef = useRef(true);
  const cancelRef = useRef(false);
  const onTranscriptionRef = useRef(onTranscription);

  useEffect(() => {
    onTranscriptionRef.current = onTranscription;
  }, [onTranscription]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const showError = useCallback(
    (description: string) => {
      showToast({ title: "Could not transcribe audio", description, tone: "default" });
    },
    [showToast],
  );

  const transcribeBlob = useCallback(
    async (blob: Blob) => {
      if (!mountedRef.current) return;
      setStatus("transcribing");
      try {
        const wav = await audioBlobTo16kMonoWav(blob);
        const form = new FormData();
        form.set("file", new File([wav], "voice-note.wav", { type: "audio/wav" }));
        const response = await fetch("/api/transcriptions", { method: "POST", body: form });
        const body = (await response.json().catch(() => ({}))) as {
          text?: unknown;
          error?: unknown;
        };
        if (!response.ok) {
          throw new Error(typeof body.error === "string" ? body.error : "Transcription failed.");
        }
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) throw new Error("No speech was detected.");
        if (mountedRef.current) onTranscriptionRef.current(text);
      } catch (error) {
        if (mountedRef.current)
          showError(error instanceof Error ? error.message : "Try recording again.");
      } finally {
        if (mountedRef.current) setStatus("idle");
      }
    },
    [showError],
  );

  const start = useCallback(async () => {
    if (status !== "idle") return;
    if (!isSupported) {
      showError("This browser does not support microphone recording.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream, preferredRecorderOptions());
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const cancelled = cancelRef.current;
        cancelRef.current = false;
        const chunks = chunksRef.current;
        chunksRef.current = [];
        recorderRef.current = null;
        cleanupStream();
        if (cancelled) {
          setStatus("idle");
          return;
        }
        if (!mountedRef.current) return;
        if (chunks.length === 0) {
          setStatus("idle");
          showError("No audio was captured.");
          return;
        }
        void transcribeBlob(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      };
      cancelRef.current = false;
      recorder.start();
      setStatus("recording");
    } catch (error) {
      cleanupStream();
      setStatus("idle");
      showError(error instanceof Error ? error.message : "Microphone permission was denied.");
    }
  }, [cleanupStream, isSupported, showError, status, transcribeBlob]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    cancelRef.current = true;
    recorder.stop();
  }, []);

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder?.state === "recording") {
        recorder.onstop = null;
        recorder.stop();
      }
      cleanupStream();
    };
  }, [cleanupStream]);

  return {
    status,
    isRecording: status === "recording",
    isTranscribing: status === "transcribing",
    isSupported,
    start,
    stop,
    cancel,
  };
}

function canRecordAudio() {
  return (
    typeof navigator === "undefined" ||
    (Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined")
  );
}

function preferredRecorderOptions(): MediaRecorderOptions | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
    return { mimeType: "audio/webm;codecs=opus" };
  }
  if (MediaRecorder.isTypeSupported("audio/mp4")) {
    return { mimeType: "audio/mp4" };
  }
  return undefined;
}

async function audioBlobTo16kMonoWav(blob: Blob): Promise<Blob> {
  const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
  const context = new AudioContextCtor();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
    const samples = resampleToMono(audioBuffer, 16_000);
    return new Blob([encodeWav(samples, 16_000)], { type: "audio/wav" });
  } finally {
    await context.close().catch(() => undefined);
  }
}

function resampleToMono(buffer: AudioBuffer, targetSampleRate: number): Float32Array {
  const ratio = buffer.sampleRate / targetSampleRate;
  const length = Math.max(1, Math.floor(buffer.duration * targetSampleRate));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, buffer.length - 1);
    const fraction = sourceIndex - left;
    let sample = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      const leftSample = data[left] ?? 0;
      const rightSample = data[right] ?? leftSample;
      sample += leftSample + (rightSample - leftSample) * fraction;
    }
    output[i] = Math.max(-1, Math.min(1, sample / buffer.numberOfChannels));
  }
  return output;
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);
  let offset = 44;
  for (const sample of samples) {
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }
  return buffer;
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
