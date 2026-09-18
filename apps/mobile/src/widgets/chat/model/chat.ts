import type { AttachmentDto } from "@opencompany/protocol/schemas";

export type DeliveryState = "queued" | "sending" | "accepted";
export type ConnectivityState = "online" | "offline" | "waiting" | "reconnecting";

export interface TextPart {
  type: "text";
  text: string;
}

export interface AttachmentPart {
  type: "attachment";
  attachment: AttachmentDto;
  localUri?: string;
}

export interface ToolPart {
  type: "tool";
  toolCallId: string;
  name: string;
  label?: string;
  detail?: string;
  status: "running" | "completed" | "failed";
  summary?: string;
  error?: string;
}

export interface ApprovalPart {
  type: "approval";
  approvalId: string;
  kind: string;
  prompt: string;
  options: string[];
  input?: Record<string, unknown>;
  status: "pending" | "sending" | "resolved";
  resolution?: "approved" | "denied" | "answered" | "canceled";
}

export interface ArtifactPart {
  type: "artifact";
  artifactId: string;
  title: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
}

export interface NoticePart {
  type: "notice";
  message: string;
}

export type ChatPart =
  | TextPart
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
