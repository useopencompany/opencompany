import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createLogger } from "@opencompany/observability";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import type { RunnerEnv } from "./env";
import { verifyGoatDictationTicket } from "./goat-dictation-auth";

export const GOAT_DICTATION_PATH = "/goat/dictation";

const DICTATION_PROTOCOL = "goat-dictation-v1";
const TICKET_PROTOCOL_PREFIX = "goat-dictation-ticket.";
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const PCM_SAMPLE_RATE = 24_000;
const PCM_CHANNELS = 1;
const PCM_BYTES_PER_SAMPLE = 2;
const MAX_PCM_BYTES = 8 * 1_024 * 1_024;
const MAX_PENDING_AUDIO_EVENTS = 512;

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-dictation",
});

type DictationControlMessage =
  | { type: "audio"; audio?: unknown }
  | { type: "stop" }
  | { type: "cancel" };

export function createGoatDictationWebSocketServer(env: RunnerEnv) {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 96 * 1_024,
    handleProtocols(protocols) {
      return protocols.has(DICTATION_PROTOCOL) ? DICTATION_PROTOCOL : false;
    },
  });

  const accept = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void acceptGoatDictationWebSocket(request, socket, head, env, webSocketServer);
  };

  return { webSocketServer, accept };
}

async function acceptGoatDictationWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  env: RunnerEnv,
  webSocketServer: WebSocketServer,
) {
  const origin = request.headers.origin;
  if (!isOriginAllowed(origin, env.allowedOrigins)) {
    logDictationReject("origin_denied", { origin: origin ?? null });
    rejectUpgrade(socket, 403, "Forbidden");
    return;
  }

  const protocols = readProtocols(request.headers["sec-websocket-protocol"]);
  const encodedTicket = protocols
    .find((protocol) => protocol.startsWith(TICKET_PROTOCOL_PREFIX))
    ?.slice(TICKET_PROTOCOL_PREFIX.length);
  const ticket = encodedTicket
    ? verifyGoatDictationTicket({ ticket: encodedTicket, secret: env.streamTokenSecret })
    : null;
  if (!ticket || !protocols.includes(DICTATION_PROTOCOL)) {
    logDictationReject("ticket_invalid", { has_ticket: Boolean(encodedTicket) });
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request);
    attachGoatDictationConnection(webSocket, env, ticket.userWorkosId);
  });
}

export function attachGoatDictationConnection(
  downstream: WebSocket,
  env: RunnerEnv,
  userWorkosId: string,
  options: {
    createUpstream?: typeof createOpenAiRealtimeSocket;
    fetchFinalTranscript?: typeof fetchFinalTranscript;
  } = {},
) {
  const openaiApiKey = env.openaiApiKey?.trim();
  if (!openaiApiKey) {
    downstream.close(4503, "Voice dictation is not configured.");
    return;
  }

  const createUpstream = options.createUpstream ?? createOpenAiRealtimeSocket;
  const transcribeFinal = options.fetchFinalTranscript ?? fetchFinalTranscript;
  const realtimeModel = env.goatDictationRealtimeModel || "gpt-4o-transcribe";
  const finalModel = env.goatDictationFinalModel || "gpt-4o-transcribe";
  const upstream = createUpstream(openaiApiKey);
  const pendingAudio: string[] = [];
  const pcmChunks: Buffer[] = [];
  let pcmBytes = 0;
  let liveTranscript = "";
  let stopped = false;
  let disposed = false;
  let upstreamReady = false;

  const sendControl = (message: Record<string, unknown>) => {
    if (downstream.readyState === WebSocket.OPEN) downstream.send(JSON.stringify(message));
  };
  const sendAudioToUpstream = (audio: string) => {
    upstream.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
  };
  const closeBoth = () => {
    if (disposed) return;
    disposed = true;
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
    if (downstream.readyState === WebSocket.OPEN) downstream.close();
  };
  const fail = (message: string) => {
    sendControl({ type: "error", message });
    closeBoth();
  };

  upstream.on("open", () => {
    upstreamReady = true;
    upstream.send(
      JSON.stringify({
        type: "transcription_session.update",
        session: {
          input_audio_format: "pcm16",
          input_audio_transcription: { model: realtimeModel },
          input_audio_noise_reduction: { type: "near_field" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      }),
    );
    for (const audio of pendingAudio.splice(0)) sendAudioToUpstream(audio);
    sendControl({ type: "ready" });
  });

  upstream.on("message", (raw) => {
    const event = parseJson(raw);
    if (!event || typeof event.type !== "string") return;
    if (event.type === "conversation.item.input_audio_transcription.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!delta) return;
      liveTranscript += delta;
      sendControl({ type: "delta", delta });
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = typeof event.transcript === "string" ? event.transcript : "";
      if (transcript) {
        liveTranscript = transcript;
        sendControl({ type: "partial", text: transcript });
      }
    } else if (event.type === "error") {
      const message =
        typeof event.error?.message === "string"
          ? event.error.message
          : "Live transcription failed.";
      logger.warn("OpenAI realtime dictation error", {
        event: "opencompany.goat_dictation_realtime_error",
        user_workos_id: userWorkosId,
        error: message,
      });
      sendControl({ type: "warning", message });
    }
  });
  upstream.on("error", () => {
    if (!disposed) fail("Live transcription connection failed.");
  });
  upstream.on("close", () => {
    if (!disposed && !stopped) fail("Live transcription connection closed.");
  });

  downstream.on("message", (raw, isBinary) => {
    if (disposed || isBinary) return;
    const message = parseJson(raw) as DictationControlMessage | null;
    if (!message || typeof message.type !== "string") {
      fail("Invalid dictation message.");
      return;
    }
    if (message.type === "cancel") {
      closeBoth();
      return;
    }
    if (message.type === "stop") {
      if (stopped) return;
      stopped = true;
      sendControl({ type: "processing" });
      if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      }
      void transcribeFinal({
        openaiApiKey,
        model: finalModel,
        pcmChunks,
        fallbackText: liveTranscript,
      })
        .then((text) => {
          sendControl({ type: "final", text });
          closeBoth();
        })
        .catch((error) => {
          logger.warn("Final dictation transcription failed", {
            event: "opencompany.goat_dictation_final_failed",
            user_workos_id: userWorkosId,
            error,
          });
          if (liveTranscript) {
            sendControl({ type: "final", text: liveTranscript });
            closeBoth();
            return;
          }
          fail("Final transcription failed.");
        });
      return;
    }
    if (message.type !== "audio" || typeof message.audio !== "string" || !message.audio) {
      fail("Invalid dictation audio.");
      return;
    }

    let chunk: Buffer;
    try {
      chunk = Buffer.from(message.audio, "base64");
    } catch {
      fail("Invalid dictation audio.");
      return;
    }
    if (chunk.byteLength === 0) return;
    if (pcmBytes + chunk.byteLength > MAX_PCM_BYTES) {
      fail("Voice dictation can record up to about 3 minutes at a time.");
      return;
    }
    pcmChunks.push(chunk);
    pcmBytes += chunk.byteLength;

    if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
      sendAudioToUpstream(message.audio);
      return;
    }
    if (pendingAudio.length >= MAX_PENDING_AUDIO_EVENTS) {
      fail("Voice dictation connection is not ready.");
      return;
    }
    pendingAudio.push(message.audio);
  });

  downstream.on("close", closeBoth);
  downstream.on("error", closeBoth);
}

export function createOpenAiRealtimeSocket(openaiApiKey: string) {
  return new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });
}

export async function fetchFinalTranscript(input: {
  openaiApiKey: string;
  model: string;
  pcmChunks: readonly Buffer[];
  fallbackText: string;
}) {
  if (input.pcmChunks.length === 0) return input.fallbackText;

  const wav = wavFromPcm16(Buffer.concat(input.pcmChunks));
  const form = new FormData();
  form.append("model", input.model);
  form.append("response_format", "json");
  form.append("file", new Blob([wav], { type: "audio/wav" }), "dictation.wav");

  const response = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.openaiApiKey}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`OpenAI transcription failed with ${response.status}.`);
  }
  const body = (await response.json()) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  return text || input.fallbackText;
}

export function wavFromPcm16(pcm: Buffer) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(PCM_CHANNELS, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(PCM_CHANNELS * PCM_BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(PCM_BYTES_PER_SAMPLE * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

function logDictationReject(reason: string, context: Record<string, unknown>) {
  logger.warn("Rejected Goat dictation connection", {
    event: "opencompany.goat_dictation_rejected",
    reject_reason: reason,
    ...context,
  });
}

function parseJson(data: RawData) {
  try {
    return JSON.parse(data.toString()) as Record<string, any>;
  } catch {
    return null;
  }
}

function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]) {
  return !origin || allowedOrigins.includes(origin);
}

function readProtocols(header: string | string[] | undefined) {
  const value = Array.isArray(header) ? header.join(",") : (header ?? "");
  return value
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

function rejectUpgrade(socket: Duplex, statusCode: number, reason: string) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`,
  );
  socket.destroy();
}
