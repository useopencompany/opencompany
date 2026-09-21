import type { AttachmentDto } from "@opencompany/protocol/schemas";

export type DeliveryState = "queued" | "sending" | "accepted";
export type ConnectivityState = "online" | "offline" | "reconnecting";

export interface TextPart {
  id: string;
  type: "text";
  text: string;
}

export interface AttachmentPart {
  id: string;
  type: "attachment";
  attachment: AttachmentDto;
  localUri?: string;
}

export interface ToolPart {
  id: string;
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
