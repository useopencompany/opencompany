import { z } from "@hono/zod-openapi";
import {
  CursorSchema,
  MessageSchema,
  PresentationCursorSchema,
  ResourceIdSchema,
  TimestampSchema,
} from "./schemas";
import { EVENT_SCHEMA_VERSION } from "./version";

const baseEvent = {
  id: ResourceIdSchema,
  runId: ResourceIdSchema,
  attemptId: ResourceIdSchema.nullable(),
  cursor: CursorSchema,
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  occurredAt: TimestampSchema,
};

function event<T extends string, S extends z.ZodType>(type: T, payload: S) {
  return z.object({ ...baseEvent, type: z.literal(type), payload }).strict();
}

export const RunEventSchema = z
  .discriminatedUnion("type", [
    event(
      "run.queued",
      z.object({ conversationId: ResourceIdSchema, triggerMessageId: ResourceIdSchema }).strict(),
    ),
    event("run.started", z.object({ attemptNumber: z.number().int().positive() }).strict()),
    event("run.cancel_requested", z.object({ by: z.enum(["user", "system"]) }).strict()),
    event("message.created", z.object({ message: MessageSchema }).strict()),
    event(
      "message.content_updated",
      z
        .object({ messageId: ResourceIdSchema, content: z.string(), complete: z.boolean() })
        .strict(),
    ),
    event(
      "tool.started",
      z
        .object({
          toolCallId: ResourceIdSchema,
          name: z.string().min(1),
          label: z.string().min(1).max(500).optional(),
          detail: z.string().min(1).max(4_000).optional(),
          kind: z.string().min(1).max(100).optional(),
          parentToolCallId: ResourceIdSchema.optional(),
        })
        .strict(),
    ),
    event(
      "tool.completed",
      z.object({ toolCallId: ResourceIdSchema, summary: z.string().optional() }).strict(),
    ),
    event(
      "tool.failed",
      z.object({ toolCallId: ResourceIdSchema, code: z.string(), message: z.string() }).strict(),
    ),
    event(
      "approval.requested",
      z
        .object({
          approvalId: ResourceIdSchema,
          // Added after the first durable-event rollout. Optional while pre-existing event rows
          // drain; all newly projected approvals include it.
          toolCallId: ResourceIdSchema.optional(),
          kind: z.string().min(1),
          prompt: z.string(),
          action: z.string().min(1).optional(),
          options: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    event(
      "approval.resolved",
      z
        .object({
          approvalId: ResourceIdSchema,
          resolution: z.enum(["approved", "denied", "answered", "canceled"]),
        })
        .strict(),
    ),
    event(
      "artifact.published",
      z
        .object({
          artifactId: ResourceIdSchema,
          title: z.string(),
          filename: z.string(),
          mediaType: z.string(),
          sizeBytes: z.number().int().min(0),
        })
        .strict(),
    ),
    event("run.paused", z.object({ reason: z.string() }).strict()),
    event("run.completed", z.object({ messageId: ResourceIdSchema }).strict()),
    event(
      "run.failed",
      z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).strict(),
    ),
    event("run.canceled", z.object({ by: z.enum(["user", "system"]) }).strict()),
  ])
  .openapi("RunEvent");

export const RunEventTypes = RunEventSchema.options.map(
  (schema: (typeof RunEventSchema.options)[number]) => schema.shape.type.value,
);

export type RunEventDto = z.infer<typeof RunEventSchema>;

export const PresentationDeltaFrameSchema = z
  .object({
    runId: ResourceIdSchema,
    attemptNumber: z.number().int().positive(),
    schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
    occurredAt: TimestampSchema,
    type: z.literal("message.presentation_delta"),
    payload: z
      .object({
        messageId: ResourceIdSchema,
        startOffset: z.number().int().min(0),
        endOffset: z.number().int().positive(),
        delta: z.string().min(1).max(262_144),
      })
      .strict()
      .refine(
        (payload: { startOffset: number; endOffset: number; delta: string }) =>
          payload.endOffset === payload.startOffset + payload.delta.length,
        { message: "Presentation delta offsets must match the delta length." },
      ),
  })
  .strict();

export const PresentationDeltaEventSchema = PresentationDeltaFrameSchema.extend({
  presentationCursor: PresentationCursorSchema,
})
  .strict()
  .openapi("PresentationDeltaEvent");

export const RunStreamEventSchema = z
  .union([z.lazy(() => RunEventSchema), PresentationDeltaEventSchema])
  .openapi("RunStreamEvent");

export type PresentationDeltaFrameDto = z.infer<typeof PresentationDeltaFrameSchema>;
export type PresentationDeltaEventDto = z.infer<typeof PresentationDeltaEventSchema>;
export type RunStreamEventDto = z.infer<typeof RunStreamEventSchema>;

export function encodeEventCursor(sequence: number | bigint): string {
  if (typeof sequence === "number" && (!Number.isSafeInteger(sequence) || sequence < 1)) {
    throw new Error("Event sequence must be a positive safe integer.");
  }
  if (typeof sequence === "bigint" && sequence < 1n) {
    throw new Error("Event sequence must be positive.");
  }
  return `v1:${sequence.toString()}`;
}

export function decodeEventCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const parsed = CursorSchema.safeParse(cursor);
  if (!parsed.success) throw new Error("Invalid event cursor.");
  const sequence = Number(cursor.slice(3));
  if (!Number.isSafeInteger(sequence)) throw new Error("Event cursor exceeds safe range.");
  return sequence;
}

export const formatEventCursor = encodeEventCursor;
export const parseEventCursor = decodeEventCursor;

export function encodePresentationCursor(streamId: string): string {
  if (!/^[1-9][0-9]*-[0-9]+$/u.test(streamId)) {
    throw new Error("Invalid presentation stream ID.");
  }
  return `p1:${streamId}`;
}

export function decodePresentationCursor(cursor: string): string {
  const parsed = PresentationCursorSchema.safeParse(cursor);
  if (!parsed.success) throw new Error("Invalid presentation cursor.");
  return cursor.slice(3);
}

export function parseRunEvent(value: unknown): RunEventDto {
  return RunEventSchema.parse(value);
}

export function parsePresentationDeltaFrame(value: unknown): PresentationDeltaFrameDto {
  return PresentationDeltaFrameSchema.parse(value);
}

export function parseRunStreamEvent(value: unknown): RunStreamEventDto {
  return RunStreamEventSchema.parse(value);
}
