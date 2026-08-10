import type { GoatChatArtifactVersion } from "@opencompany/db/goat-schema";
import { get } from "@vercel/blob";

const INLINE_MEDIA_TYPES = new Set([
  "application/json",
  "application/pdf",
  "application/x-subrip",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
]);

export async function goatChatArtifactResponse(
  version: Pick<GoatChatArtifactVersion, "blobPathname" | "filename" | "mediaType" | "sizeBytes">,
  options: { download: boolean },
): Promise<Response> {
  const result = await get(version.blobPathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) {
    return new Response(null, { status: 404 });
  }

  const inline = !options.download && INLINE_MEDIA_TYPES.has(version.mediaType);
  return new Response(result.stream, {
    headers: {
      "Content-Type": version.mediaType || "application/octet-stream",
      "Content-Length": String(version.sizeBytes),
      "Content-Disposition": contentDisposition(version.filename, inline),
      // Files can be explicitly deleted, so neither owner nor public-share URLs may retain
      // a readable cached copy after the tombstone is written.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      ...(inline ? { "Content-Security-Policy": "sandbox" } : {}),
    },
  });
}

function contentDisposition(value: string | null, inline: boolean) {
  const original = (value ?? "file").replace(/[\u0000-\u001f\u007f]/g, "_").trim() || "file";
  // The quoted fallback must stay ASCII for Node's Headers implementation. filename* preserves
  // the actual UTF-8 name for modern browsers without allowing header injection.
  const fallback = original.replace(/[^\x20-\x7e]|["\\]/g, "_") || "file";
  const encoded = encodeURIComponent(original).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
