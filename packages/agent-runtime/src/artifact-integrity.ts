// Canonical content integrity for skill and plugin artifacts.
//
// This algorithm is new and has no legacy mode. It commits to the complete, ordered set of files
// by hashing, for each file sorted by its raw relative-path bytes, the path, the raw content, and
// the executable bit — every variable-length field carried with an explicit length prefix so no
// two distinct file sets can ever serialize to the same byte stream (length-extension /
// concatenation ambiguity is impossible). Raw bytes are the authority; nothing is decoded.

// A single retained file. `content` is the exact bytes; `executable` is the Git executable bit.
export type ArtifactFile = {
  path: string;
  content: Uint8Array;
  executable: boolean;
};

// Domain tag so an integrity value can never collide with an unrelated hash of the same bytes, and
// so the scheme is explicitly versioned even though only one version exists.
const DOMAIN_TAG = "opencompany.artifact-integrity.v1";

const textEncoder = new TextEncoder();

// Big-endian u64 length prefix. u64 is overkill for our size limits but removes any doubt about
// overflow and keeps every field's framing identical.
function u64BE(value: number): Uint8Array {
  const out = new Uint8Array(8);
  let remaining = value;
  for (let i = 7; i >= 0; i--) {
    out[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

// Byte-wise lexical comparison of two paths' UTF-8 encodings. Sorting on raw bytes (rather than JS
// UTF-16 code units) keeps the ordering — and therefore the hash — stable and unambiguous.
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av !== bv) return av - bv;
  }
  return a.length - b.length;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  // Back the buffer with a concrete ArrayBuffer so the result is accepted as a BufferSource by
  // crypto.subtle.digest under strict lib typings.
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

// Compute the canonical `sha256:<hex>` integrity for a set of artifact files. Order-independent
// (files are sorted here), path-sensitive, content-sensitive, and executable-bit-sensitive. Runs
// in both browser and server runtimes through Web Crypto.
export async function computeArtifactIntegrity(files: ArtifactFile[]): Promise<string> {
  const encoded = files.map((file) => ({
    pathBytes: textEncoder.encode(file.path),
    content: file.content,
    executable: file.executable,
  }));
  encoded.sort((a, b) => compareBytes(a.pathBytes, b.pathBytes));

  const chunks: Uint8Array[] = [textEncoder.encode(DOMAIN_TAG), u64BE(encoded.length)];
  for (const file of encoded) {
    chunks.push(u64BE(file.pathBytes.length), file.pathBytes);
    chunks.push(u64BE(file.content.length), file.content);
    chunks.push(Uint8Array.of(file.executable ? 1 : 0));
  }

  const digest = await globalThis.crypto.subtle.digest("SHA-256", concatBytes(chunks));
  return `sha256:${toHex(new Uint8Array(digest))}`;
}
