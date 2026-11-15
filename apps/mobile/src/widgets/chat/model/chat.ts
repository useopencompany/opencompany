import type { AttachmentDto } from "@opencompany/protocol/schemas";

export type DeliveryState = "queued" | "sending" | "accepted";
export type ConnectivityState = "online" | "offline" | "reconnecting";

export interface TextPart {
  id: string;
  type: "text";
  text: string;
  /** The engine's message identity. Adjacent text with different items stays separate messages. */
  itemId?: string;
}

/**
 * Where a part sits among its siblings in the server's presentation. Live parts that only exist
 * on this device have none; a live reasoning frame uses it to land before later activity.
 */
interface PresentationPosition {
  sourceIndex?: number;
}

export interface ReasoningPart extends PresentationPosition {
  id: string;
  type: "reasoning";
  itemId: string;
  text: string;
  streaming: boolean;
  /** The Run attempt that streamed this text. Absent once a canonical presentation replaced it. */
  attempt?: number;
}

export interface SteeringPart extends PresentationPosition {
  id: string;
  type: "steering";
  text: string;
}

export interface AttachmentPart {
  id: string;
  type: "attachment";
  attachment: AttachmentDto;
  localUri?: string;
}

export type ToolStatus = "running" | "waiting" | "completed" | "failed" | "denied" | "interrupted";

export interface ToolPart extends PresentationPosition {
  id: string;
  type: "tool";
  toolCallId: string;
  /** The tool's registered name, such as `web_search` or `codex_command`. */
  name: string;
  /** Label and detail a lifecycle event carried before the full presentation arrived. */
  label?: string;
  detail?: string;
  status: ToolStatus;
  /** The raw AI SDK part state, such as `output-available`. */
  state?: string;
  /** Identity fields from the part envelope (title, kind, server, tool). Never tool arguments. */
  metadata?: Record<string, unknown>;
  /**
   * Complete arguments and result. An absent key means the value is unknown on this device; a
   * present `null` is a value the tool really sent.
   */
  input?: unknown;
  output?: unknown;
  summary?: string;
  error?: string;
  /** A subagent's own trace, in order. */
  children?: ChatPart[];
}

export interface ApprovalPart {
  id: string;
  type: "approval";
  approvalId: string;
  toolCallId?: string;
  kind: string;
  prompt: string;
  options: string[];
  input?: Record<string, unknown>;
  status: "pending" | "sending" | "resolved";
  resolution?: "approved" | "denied" | "answered" | "canceled";
}

export interface ArtifactPart {
  id: string;
  type: "artifact";
  artifactId: string;
  title: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
}

export interface NoticePart {
  id: string;
  type: "notice";
  message: string;
  kind?: "error";
}

export type ChatPart =
  | TextPart
  | ReasoningPart
  | SteeringPart
  | AttachmentPart
  | ToolPart
  | ApprovalPart
  | ArtifactPart
  | NoticePart;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: ChatPart[];
  createdAt: number;
  delivery: DeliveryState;
}
