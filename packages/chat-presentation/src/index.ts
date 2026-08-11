import { type PresentationDeltaFrameDto, parsePresentationDeltaFrame } from "@opencompany/protocol";
import { createClient, type RedisClientType } from "redis";

export const CHAT_PRESENTATION_STREAM_TTL_SECONDS = 5 * 60;
export const CHAT_PRESENTATION_STREAM_MAX_LENGTH = 1_024;
export const CHAT_PRESENTATION_READ_LIMIT = 100;

export type ChatPresentationEntry = {
  streamId: string;
  frame: PresentationDeltaFrameDto;
};

export type ChatPresentationReadResult = {
  status: "available" | "unavailable";
  entries: ChatPresentationEntry[];
  nextStreamId: string | null;
};

export interface ChatPresentationPublisher {
  publish(frame: PresentationDeltaFrameDto): void;
}

export interface ChatPresentationReader {
  read(input: {
    runId: string;
    afterStreamId?: string;
    limit?: number;
  }): Promise<ChatPresentationReadResult>;
}

type RedisClient = RedisClientType;

export class RedisChatPresentationStream
  implements ChatPresentationPublisher, ChatPresentationReader
{
  private clientPromise: Promise<RedisClient> | null = null;
  private readonly pendingFrames = new Map<string, PresentationDeltaFrameDto>();
  private drainPromise: Promise<void> | null = null;
  private unavailableUntil = 0;
  private outageReported = false;
  private closed = false;

  constructor(
    private readonly options: {
      url: string;
      onError?: (input: { operation: "connect" | "publish" | "read"; error: unknown }) => void;
      now?: () => number;
      retryDelayMs?: number;
      commandTimeoutMs?: number;
      createClient?: (url: string) => RedisClient;
    },
  ) {}

  publish(frame: PresentationDeltaFrameDto) {
    if (this.closed) return;
    let parsed: PresentationDeltaFrameDto;
    try {
      parsed = parsePresentationDeltaFrame(frame);
    } catch (error) {
      this.reportOutage("publish", error);
      return;
    }
    const pending = this.pendingFrames.get(parsed.runId);
    this.pendingFrames.set(parsed.runId, coalesceFrames(pending, parsed));
    this.startDrain();
  }

  async read(input: {
    runId: string;
    afterStreamId?: string;
    limit?: number;
  }): Promise<ChatPresentationReadResult> {
    const limit = Math.max(1, Math.min(CHAT_PRESENTATION_READ_LIMIT, input.limit ?? 50));
    const result = await this.runCommand("read", async (client) => {
      const key = streamKey(input.runId);
      const streams = input.afterStreamId
        ? await client.xRead({ key, id: input.afterStreamId }, { COUNT: limit })
        : null;
      const messages = input.afterStreamId
        ? (streams?.flatMap((stream) => stream.messages) ?? [])
        : await client.xRange(key, "-", "+", { COUNT: limit });
      const entries: ChatPresentationEntry[] = [];
      for (const message of messages) {
        try {
          const frame = parsePresentationDeltaFrame(JSON.parse(String(message.message.frame)));
          if (frame.runId === input.runId) entries.push({ streamId: message.id, frame });
        } catch (error) {
          this.reportOutage("read", error);
        }
      }
      return {
        entries,
        nextStreamId: messages.at(-1)?.id ?? input.afterStreamId ?? null,
      };
    });
    return result
      ? { status: "available", ...result }
      : { status: "unavailable", entries: [], nextStreamId: input.afterStreamId ?? null };
  }

  async close() {
    this.closed = true;
    this.pendingFrames.clear();
    await this.drainPromise?.catch(() => undefined);
    const client = await this.clientPromise?.catch(() => null);
    this.clientPromise = null;
    client?.destroy();
  }

  private startDrain() {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (!this.closed && this.pendingFrames.size > 0) this.startDrain();
    });
  }

  private async drain() {
    while (!this.closed && this.pendingFrames.size > 0) {
      const frames = [...this.pendingFrames.values()];
      this.pendingFrames.clear();
      for (const frame of frames) {
        await this.runCommand("publish", async (client) => {
          const key = streamKey(frame.runId);
          const transaction = client.multi();
          transaction.xAdd(
            key,
            "*",
            { frame: JSON.stringify(frame) },
            {
              TRIM: {
                strategy: "MAXLEN",
                strategyModifier: "=",
                threshold: CHAT_PRESENTATION_STREAM_MAX_LENGTH,
              },
            },
          );
          transaction.expire(key, CHAT_PRESENTATION_STREAM_TTL_SECONDS);
          await transaction.exec();
        });
      }
    }
  }

  private async runCommand<T>(
    operation: "publish" | "read",
    command: (client: RedisClient) => Promise<T>,
  ): Promise<T | null> {
    if (this.closed || this.now() < this.unavailableUntil) return null;
    try {
      const result = await withTimeout(
        (async () => command(await this.client()))(),
        this.options.commandTimeoutMs ?? 250,
      );
      this.outageReported = false;
      return result;
    } catch (error) {
      this.markUnavailable(operation, error);
      return null;
    }
  }

  private client() {
    this.clientPromise ??= this.connectClient();
    return this.clientPromise;
  }

  private async connectClient() {
    let client: RedisClient | null = null;
    try {
      client = this.options.createClient
        ? this.options.createClient(this.options.url)
        : (createClient({
            url: this.options.url,
            disableOfflineQueue: true,
            socket: { connectTimeout: 500, reconnectStrategy: false },
          }) as RedisClient);
      client.on("error", (error) => this.reportOutage("connect", error));
      await client.connect();
      return client;
    } catch (error) {
      client?.destroy();
      this.clientPromise = null;
      this.markUnavailable("connect", error);
      throw error;
    }
  }

  private markUnavailable(operation: "connect" | "publish" | "read", error: unknown) {
    this.unavailableUntil = this.now() + (this.options.retryDelayMs ?? 1_000);
    const clientPromise = this.clientPromise;
    this.clientPromise = null;
    void clientPromise?.then((client) => client.destroy()).catch(() => undefined);
    this.reportOutage(operation, error);
  }

  private reportOutage(operation: "connect" | "publish" | "read", error: unknown) {
    if (this.outageReported) return;
    this.outageReported = true;
    this.options.onError?.({ operation, error });
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }
}

function streamKey(runId: string) {
  return `opencompany:chat:presentation:v1:${Buffer.from(runId).toString("base64url")}`;
}

function coalesceFrames(
  pending: PresentationDeltaFrameDto | undefined,
  next: PresentationDeltaFrameDto,
) {
  if (
    pending?.attemptNumber !== next.attemptNumber ||
    pending.payload.messageId !== next.payload.messageId ||
    pending.payload.endOffset !== next.payload.startOffset
  ) {
    return next;
  }
  return {
    ...next,
    payload: {
      ...next.payload,
      startOffset: pending.payload.startOffset,
      delta: pending.payload.delta + next.payload.delta,
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Redis presentation command timed out.")),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
