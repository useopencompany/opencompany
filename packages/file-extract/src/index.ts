import { formatFromBytes, formatFromExtension, toMarkdownBytes } from "@firecrawl/anydoc";

const DEFAULT_MAX_BYTES = 200_000;

// AnyDoc's `Format` is an ambient const enum, which `isolatedModules` forbids us from referencing by
// member. We derive the format values we need from the detection helpers instead.
type DocumentFormat = NonNullable<ReturnType<typeof formatFromBytes>>;
const CSV_FORMAT = formatFromExtension("csv") as DocumentFormat;
const PDF_FORMAT = formatFromExtension("pdf") as DocumentFormat;

export type ExtractOptions = {
  // Output is truncated once it exceeds this many UTF-8 bytes.
  maxBytes?: number;
};

// Stable application errors the callers can branch on, independent of the underlying parser.
export type DocumentExtractionErrorKind =
  | "unsupported" // Unknown or unhandled file type.
  | "image_only_pdf" // Scanned/image-only PDF; OCR is out of scope.
  | "encrypted" // Password-protected or otherwise encrypted.
  | "malformed" // Structurally unusable input.
  | "resource_limit" // Crossed a parser safety limit (decompression, nesting, node count).
  | "io"; // The bytes could not be read.

export class DocumentExtractionError extends Error {
  readonly kind: DocumentExtractionErrorKind;

  constructor(kind: DocumentExtractionErrorKind, message: string) {
    super(message);
    this.name = "DocumentExtractionError";
    this.kind = kind;
  }
}

export type DocumentExtraction = {
  // Markdown for the document, capped to `maxOutputBytes` UTF-8 bytes.
  markdown: string;
  // True when the source produced more Markdown than the cap retained.
  truncated: boolean;
  // The resolved input format, for source metadata. "text" is the plain-text/Markdown path.
  format: DocumentFormat | "text";
};

export type ExtractDocumentInput = {
  bytes: Buffer;
  // Original filename, used only to resolve signature-less formats (CSV) and the text path.
  filename?: string;
  // Declared media type, used the same way as `filename`.
  mediaType?: string;
  // Cap on retained Markdown; defaults to 200 KB.
  maxOutputBytes?: number;
};

// Single parsing entry point. Binary formats are detected from the bytes themselves; the filename
// and media type only disambiguate signature-less inputs (CSV) and the plain-text/Markdown path.
export async function extractDocumentMarkdown(
  input: ExtractDocumentInput,
): Promise<DocumentExtraction> {
  const maxBytes = input.maxOutputBytes ?? DEFAULT_MAX_BYTES;
  const detected = formatFromBytes(input.bytes);

  if (detected) {
    return capResult(await convert(input.bytes, detected), detected, maxBytes);
  }

  // No binary signature: fall back to the filename/media-type hints.
  const hint = textHint(input.filename, input.mediaType);
  if (hint === "csv") {
    return capResult(await convert(input.bytes, CSV_FORMAT), CSV_FORMAT, maxBytes);
  }
  if (hint === "text") {
    return capResult(decodeUtf8(input.bytes), "text", maxBytes);
  }

  throw new DocumentExtractionError(
    "unsupported",
    "Unsupported file type: no recognized document format could be detected.",
  );
}

// Plain UTF-8 decode for the text/Markdown path. Strict so binary masquerading as text is rejected.
export function extractUtf8Text(bytes: Buffer, options: ExtractOptions = {}): string {
  return capBytes(decodeUtf8(bytes), options.maxBytes ?? DEFAULT_MAX_BYTES);
}

async function convert(bytes: Buffer, format: DocumentFormat): Promise<string> {
  try {
    return (await toMarkdownBytes(bytes, format)).trim();
  } catch (error) {
    throw normalizeError(error, format);
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new DocumentExtractionError("malformed", "Document is not valid UTF-8 text.");
  }
}

function capResult(
  markdown: string,
  format: DocumentFormat | "text",
  maxBytes: number,
): DocumentExtraction {
  const capped = capBytes(markdown, maxBytes);
  return { markdown: capped, truncated: capped.length < markdown.length, format };
}

// Maps AnyDoc's ConvertErrorCode onto the stable application errors. A PDF that AnyDoc reports as
// `unsupported` was recognized as a PDF but yielded no text, i.e. it is scanned/image-only.
function normalizeError(error: unknown, format: DocumentFormat): DocumentExtractionError {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : "Document could not be parsed.";
  switch (code) {
    case "unsupported":
      return format === PDF_FORMAT
        ? new DocumentExtractionError(
            "image_only_pdf",
            "This PDF is scanned or image-only; text extraction (OCR) is not supported.",
          )
        : new DocumentExtractionError("unsupported", message);
    case "encrypted":
      return new DocumentExtractionError(
        "encrypted",
        "Document is encrypted or password-protected.",
      );
    case "resourceLimit":
      return new DocumentExtractionError(
        "resource_limit",
        "Document exceeded a parser safety limit.",
      );
    case "io":
      return new DocumentExtractionError("io", "Document bytes could not be read.");
    default:
      // `malformed`, `missingPart`, and anything unexpected are all structurally-unusable input.
      return new DocumentExtractionError("malformed", message);
  }
}

const TEXT_EXTENSIONS = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "mdown",
  "json",
  "ndjson",
  "srt",
  "vtt",
  "tsv",
  "log",
]);

// Classifies a signature-less input from its filename/media type. Returns null when neither hint
// indicates a text-based format, so the caller can reject it as unsupported.
function textHint(
  filename: string | undefined,
  mediaType: string | undefined,
): "csv" | "text" | null {
  const type = mediaType?.split(";")[0]?.trim().toLowerCase();
  if (type === "text/csv" || type === "application/csv") return "csv";
  if (type === "application/json" || type === "application/x-ndjson") return "text";
  if (type?.startsWith("text/")) return "text";

  const extension = fileExtension(filename);
  if (extension === "csv") return "csv";
  if (extension && TEXT_EXTENSIONS.has(extension)) return "text";
  return null;
}

function fileExtension(filename: string | undefined): string | null {
  if (!filename) return null;
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

function capBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const truncated = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  // Drop a possibly split trailing code point left by the byte-boundary cut.
  return truncated.replace(/�+$/, "");
}
