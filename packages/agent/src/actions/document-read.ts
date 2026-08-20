import { DocumentExtractionError, extractDocumentMarkdown } from "@opencompany/file-extract";
import { ActionInvalidParamsError, optionalNumberParam } from "./types";

// A single parse retains up to ~200 KB of Markdown; each call returns a ~40 KB
// character window with continuation offsets. maxResultChars leaves room for the
// window plus source metadata, still under the executor's expanded ceiling.
export const DOCUMENT_MAX_OUTPUT_BYTES = 200_000;
export const DOCUMENT_WINDOW_CHARS = 40_000;
export const DOCUMENT_READ_MAX_RESULT_CHARS = 48_000;
export const DOCUMENT_READ_TIMEOUT_MS = 60_000;
export const MAX_DOCUMENT_INPUT_BYTES = 20 * 1024 * 1024;

// Reasons a document could not be read, surfaced as a stable machine-readable
// field. Extends the parser's kinds with the pre-parse download limit.
export type DocumentReadErrorKind = DocumentExtractionError["kind"] | "too_large";

export type DocumentReadContent =
  | {
      ok: true;
      format: string;
      markdown: string;
      offset: number;
      nextOffset?: number;
      truncated: boolean;
    }
  | { ok: false; error: DocumentReadErrorKind; reason: string };

// Flattens a read result into the fields an action returns alongside its source
// metadata, so Gmail and Drive present attachments identically.
export function documentContentFields(content: DocumentReadContent): Record<string, unknown> {
  if (!content.ok) return { error: content.error, reason: content.reason };
  return {
    format: content.format,
    markdown: content.markdown,
    offset: content.offset,
    ...(content.nextOffset !== undefined ? { nextOffset: content.nextOffset } : {}),
    truncated: content.truncated,
  };
}

export function readOffsetParam(params: Record<string, unknown>): number {
  const offset = optionalNumberParam(params, "offset");
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ActionInvalidParamsError('"offset" must be a non-negative integer character offset.');
  }
  return offset;
}

// Parses bytes to Markdown once and returns the requested character window with
// continuation metadata. A DocumentExtractionError becomes a clean ok:false
// result (unsupported / image_only_pdf / encrypted / malformed / …) rather than a
// throw, so the model can relay the reason to the user.
export async function readDocumentWindow(input: {
  bytes: Buffer;
  filename?: string | undefined;
  mediaType?: string | undefined;
  offset: number;
}): Promise<DocumentReadContent> {
  let markdown: string;
  let format: string;
  let parseTruncated: boolean;
  try {
    const extraction = await extractDocumentMarkdown({
      bytes: input.bytes,
      filename: input.filename,
      mediaType: input.mediaType,
      maxOutputBytes: DOCUMENT_MAX_OUTPUT_BYTES,
    });
    markdown = extraction.markdown;
    format = extraction.format;
    parseTruncated = extraction.truncated;
  } catch (error) {
    if (error instanceof DocumentExtractionError) {
      return { ok: false, error: error.kind, reason: error.message };
    }
    throw error;
  }

  const offset = Math.min(Math.max(input.offset, 0), markdown.length);
  const window = markdown.slice(offset, offset + DOCUMENT_WINDOW_CHARS);
  const end = offset + window.length;
  const hasMore = end < markdown.length;
  return {
    ok: true,
    format,
    markdown: window,
    offset,
    ...(hasMore ? { nextOffset: end } : {}),
    // Incomplete either because more windows remain or the parse hit the retain cap.
    truncated: hasMore || parseTruncated,
  };
}
