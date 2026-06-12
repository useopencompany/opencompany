"use client";

import { upload } from "@vercel/blob/client";

// Uploads a feedback screenshot client-direct to the PRIVATE Vercel Blob store. Like session
// attachments, this bypasses the 4.5 MB serverless body limit (see app/api/upload/route.ts) — but
// here the blob is only a TRANSIT buffer: submitFeedback reads the bytes back server-side, pushes
// them to Linear's own storage (its CSP blocks client-side uploads), embeds the returned asset URL
// inline in the issue, then deletes this blob. The path is workspace-scoped under `feedback/` so the
// /api/upload token mint accepts it and the submit action can verify the caller owns it.
// Mirrors uploadAttachment() in components/composer-attachments.tsx.
export async function uploadFeedbackImage(input: {
  id: string;
  file: File;
  workspaceId: string;
}): Promise<{ blobPathname: string; blobUrl: string }> {
  const safeName = input.file.name.replace(/[^\w.\-]+/g, "_") || "image";
  const pathname = `workspace/${input.workspaceId}/feedback/${input.id}-${safeName}`;
  const blob = await upload(pathname, input.file, {
    access: "private",
    handleUploadUrl: "/api/upload",
    contentType: input.file.type,
  });
  return { blobPathname: blob.pathname, blobUrl: blob.url };
}
