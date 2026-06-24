"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ToastProvider";

type VoiceTranscriptionStatus = "idle" | "recording" | "transcribing";

type VoiceTranscriptionOptions = {
  onTranscription: (text: string) => void;
};

type VoiceAudioInputDevice = {
  id: string;
  label: string;
  isBluetooth: boolean;
};

const AUDIO_LEVEL_COUNT = 96;
const BASE_AUDIO_LEVEL = 0.12;
const AUDIO_LEVEL_UPDATE_MS = 56;
const AUDIO_LEVELS_PER_UPDATE = 1;
const RECORDING_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

function initialAudioLevels() {
  return Array.from({ length: AUDIO_LEVEL_COUNT }, (_, index) => {
    const wave = Math.sin(index * 0.62) * 0.035 + Math.sin(index * 0.19) * 0.025;
    return clampAudioLevel(BASE_AUDIO_LEVEL + wave);
  });
}

function recordingEntryAudioLevels() {
  return Array.from({ length: AUDIO_LEVEL_COUNT }, (_, index) => {
    const wave = Math.sin(index * 0.42) * 0.028 + Math.sin(index * 0.13) * 0.018;
    return clampAudioLevel(0.15 + wave);
  });
}

function audioLevelBurst(level: number, offset: number) {
  return Array.from({ length: AUDIO_LEVELS_PER_UPDATE }, (_, index) => {
    const position = offset + index;
    const wave = Math.sin(position * 0.54) * 0.055 + Math.sin(position * 0.18) * 0.03;
    return clampAudioLevel(level + wave);
  });
}

function clampAudioLevel(level: number) {
  return Math.max(BASE_AUDIO_LEVEL, Math.min(1, level));
}

async function openRecordingStream() {
  return openBestQualityRecordingStream();
}

async function openBestQualityRecordingStream() {
  const preferredDeviceId = await getPreferredAudioInputDeviceId();
  if (preferredDeviceId) {
    try {
      return await getRecordingStreamForDevice(preferredDeviceId);
    } catch {
      // The preferred mic may have disappeared since enumeration; retry with the browser default.
    }
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: RECORDING_AUDIO_CONSTRAINTS,
  });
  const selectedTrackLabel = stream.getAudioTracks()[0]?.label ?? "";
  if (!isBluetoothMicrophoneLabel(selectedTrackLabel)) return stream;

  const fallbackDeviceId = await getPreferredAudioInputDeviceId();
  if (!fallbackDeviceId) return stream;

  try {
    const fallbackStream = await getRecordingStreamForDevice(fallbackDeviceId);
    stopStream(stream);
    return fallbackStream;
  } catch {
    return stream;
  }
}

async function getPreferredAudioInputDeviceId() {
  const devices = await listAudioInputDevices();
  return devices
    .filter((device) => !device.isBluetooth)
    .sort((a, b) => scoreAudioInputDevice(b) - scoreAudioInputDevice(a))[0]?.id;
}

async function listAudioInputDevices(): Promise<VoiceAudioInputDevice[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }

  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }

  return devices
    .filter((device) => device.kind === "audioinput" && device.deviceId && device.label.trim())
    .map((device) => ({
      id: device.deviceId,
      label: cleanAudioInputLabel(device.label),
      isBluetooth: isBluetoothMicrophoneLabel(device.label),
    }));
}

function getRecordingStreamForDevice(deviceId: string) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...RECORDING_AUDIO_CONSTRAINTS,
      deviceId: { exact: deviceId },
    },
  });
}

function scoreAudioInputDevice(device: VoiceAudioInputDevice) {
  const label = normalizeDeviceLabel(device.label);
  let score = 0;
  if (
    /\b(macbook|built[- ]?in|internal|studio display|imac|iphone microphone|continuity)\b/.test(
      label,
    )
  ) {
    score += 80;
  }
  if (/\b(usb|external|microphone|mikrofon|mic)\b/.test(label)) score += 30;
  if (!isAliasAudioDeviceId(device.id)) score += 20;
  return score;
}

function isBluetoothMicrophoneLabel(label: string) {
  return /\b(airpods?|bluetooth|hands[- ]?free|beats|buds|earbuds|pods pro|wh-\d|wf-\d|jabra|soundcore)\b/.test(
    normalizeDeviceLabel(label),
  );
}

function isAliasAudioDeviceId(deviceId: string) {
  return deviceId === "default" || deviceId === "communications";
}

function normalizeDeviceLabel(label: string) {
  return label.toLowerCase();
}

function cleanAudioInputLabel(label: string) {
  return label.replace(/\s+/g, " ").trim();
}

function stopStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}

export function useVoiceTranscription({ onTranscription }: VoiceTranscriptionOptions) {
  const { showToast } = useToast();
  const [status, setStatus] = useState<VoiceTranscriptionStatus>("idle");
  const [audioLevels, setAudioLevels] = useState<number[]>(initialAudioLevels);
  const isSupported = canRecordAudio();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const meterContextRef = useRef<AudioContext | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const meterLastUpdateRef = useRef(0);
  const meterSmoothedLevelRef = useRef(BASE_AUDIO_LEVEL);
  const meterBurstOffsetRef = useRef(0);
  const chunksRef = useRef<Blob[]>([]);
  const mountedRef = useRef(true);
  const cancelRef = useRef(false);
  const startRequestRef = useRef(0);
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

  const cleanupAudioMeter = useCallback(() => {
    if (meterFrameRef.current !== null) {
      cancelAnimationFrame(meterFrameRef.current);
      meterFrameRef.current = null;
    }
    const context = meterContextRef.current;
    meterContextRef.current = null;
    meterLastUpdateRef.current = 0;
    meterSmoothedLevelRef.current = BASE_AUDIO_LEVEL;
    meterBurstOffsetRef.current = 0;
    if (mountedRef.current) setAudioLevels(initialAudioLevels());
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  }, []);

  const cleanupStream = useCallback(() => {
    cleanupAudioMeter();
    if (streamRef.current) stopStream(streamRef.current);
    streamRef.current = null;
  }, [cleanupAudioMeter]);

  const startAudioMeter = useCallback(
    (stream: MediaStream) => {
      const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
      if (!AudioContextCtor) return;
      try {
        meterSmoothedLevelRef.current = 0.16;
        meterBurstOffsetRef.current = 0;
        setAudioLevels(recordingEntryAudioLevels());
        const context = new AudioContextCtor();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.86;
        context.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        meterContextRef.current = context;

        const tick = (time: number) => {
          if (!mountedRef.current || streamRef.current !== stream) return;
          analyser.getByteTimeDomainData(data);
          let sumSquares = 0;
          for (const value of data) {
            const centered = (value - 128) / 128;
            sumSquares += centered * centered;
          }
          const rms = Math.sqrt(sumSquares / data.length);
          const rawLevel = Math.min(1, rms * 6.8);
          const previousLevel = meterSmoothedLevelRef.current;
          const attack = rawLevel > previousLevel ? 0.24 : 0.1;
          const smoothedLevel = previousLevel * (1 - attack) + rawLevel * attack;
          meterSmoothedLevelRef.current = smoothedLevel;

          if (time - meterLastUpdateRef.current >= AUDIO_LEVEL_UPDATE_MS) {
            const nextLevel = clampAudioLevel(smoothedLevel);
            const nextBurst = audioLevelBurst(nextLevel, meterBurstOffsetRef.current);
            setAudioLevels((levels) => [...levels.slice(nextBurst.length), ...nextBurst]);
            meterBurstOffsetRef.current += nextBurst.length;
            meterLastUpdateRef.current = time;
          }
          meterFrameRef.current = requestAnimationFrame(tick);
        };

        meterFrameRef.current = requestAnimationFrame(tick);
      } catch {
        cleanupAudioMeter();
      }
    },
    [cleanupAudioMeter],
  );

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
    const requestId = startRequestRef.current + 1;
    startRequestRef.current = requestId;
    cancelRef.current = false;
    chunksRef.current = [];
    setAudioLevels(recordingEntryAudioLevels());
    setStatus("recording");
    try {
      const stream = await openRecordingStream();
      if (startRequestRef.current !== requestId || cancelRef.current || !mountedRef.current) {
        stopStream(stream);
        if (startRequestRef.current === requestId) {
          cancelRef.current = false;
          if (mountedRef.current) setStatus("idle");
        }
        return;
      }
      streamRef.current = stream;
      startAudioMeter(stream);
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
      recorder.start();
    } catch (error) {
      if (startRequestRef.current !== requestId) return;
      cancelRef.current = false;
      cleanupStream();
      setStatus("idle");
      showError(error instanceof Error ? error.message : "Microphone permission was denied.");
    }
  }, [cleanupStream, isSupported, showError, startAudioMeter, status, transcribeBlob]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      startRequestRef.current += 1;
      cancelRef.current = true;
      cleanupStream();
      setStatus("idle");
      return;
    }
    recorder.stop();
  }, [cleanupStream]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      startRequestRef.current += 1;
      cancelRef.current = true;
      cleanupStream();
      setStatus("idle");
      return;
    }
    cancelRef.current = true;
    recorder.stop();
  }, [cleanupStream]);

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
    audioLevels,
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
