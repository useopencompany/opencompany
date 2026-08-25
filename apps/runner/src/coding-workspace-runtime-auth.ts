import { createHmac, timingSafeEqual } from "node:crypto";

const TICKET_VERSION = 1;
const LEGACY_PREVIEW_CAPABILITY_VERSION = 1;
const PREVIEW_CAPABILITY_VERSION = 2;
const PREVIEW_SIGNATURE_BYTES = 16;
const LEGACY_CODING_SESSION_PREFIX = "goat_codex_chat_";
const CODING_SESSION_PREFIX = "runtime_";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

type CodingWorkspaceTicketPayload = {
  v: 1;
  codingSessionId: string;
  userWorkosId: string;
  expiresAt: number;
};

export function createCodingWorkspaceTicket(input: {
  codingSessionId: string;
  userWorkosId: string;
  secret: string;
  now?: number;
  ttlMs?: number;
}) {
  const expiresAt = (input.now ?? Date.now()) + (input.ttlMs ?? 60_000);
  const encodedPayload = Buffer.from(
    JSON.stringify({
      v: TICKET_VERSION,
      codingSessionId: input.codingSessionId,
      userWorkosId: input.userWorkosId,
      expiresAt,
    } satisfies CodingWorkspaceTicketPayload),
  ).toString("base64url");
  const signature = sign("goat-coding-workspace-ticket", encodedPayload, input.secret);

  return { ticket: `${encodedPayload}.${signature}`, expiresAt };
}

export function verifyCodingWorkspaceTicket(input: {
  ticket: string;
  secret: string;
  now?: number;
}): CodingWorkspaceTicketPayload | null {
  const separator = input.ticket.lastIndexOf(".");
  if (separator <= 0) return null;

  const encodedPayload = input.ticket.slice(0, separator);
  const suppliedSignature = input.ticket.slice(separator + 1);
  if (
    !safeEqual(
      sign("goat-coding-workspace-ticket", encodedPayload, input.secret),
      suppliedSignature,
    )
  ) {
    return null;
  }

  try {
    const value = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<CodingWorkspaceTicketPayload>;
    if (
      value.v !== TICKET_VERSION ||
      typeof value.codingSessionId !== "string" ||
      !hasCodingSessionPrefix(value.codingSessionId) ||
      typeof value.userWorkosId !== "string" ||
      !value.userWorkosId ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= (input.now ?? Date.now())
    ) {
      return null;
    }
    return value as CodingWorkspaceTicketPayload;
  } catch {
    return null;
  }
}

export function createCodingWorkspacePreviewCapability(input: {
  codingSessionId: string;
  port: number;
  secret: string;
  now?: number;
  ttlMs?: number;
}) {
  assertPreviewPort(input.port);
  const { uuidBytes, version } = parseCodingSessionUuid(input.codingSessionId);
  const expiresAtSeconds = Math.floor(
    ((input.now ?? Date.now()) + (input.ttlMs ?? 8 * 60 * 60_000)) / 1_000,
  );
  const body = Buffer.alloc(23);
  body.writeUInt8(version, 0);
  uuidBytes.copy(body, 1);
  body.writeUInt16BE(input.port, 17);
  body.writeUInt32BE(expiresAtSeconds, 19);
  const signature = signBytes(
    "goat-coding-workspace-preview-capability",
    body,
    input.secret,
  ).subarray(0, PREVIEW_SIGNATURE_BYTES);

  return {
    capability: encodeBase32(Buffer.concat([body, signature])),
    expiresAt: expiresAtSeconds * 1_000,
  };
}

export function verifyCodingWorkspacePreviewCapability(input: {
  capability: string;
  secret: string;
  now?: number;
}) {
  let bytes: Buffer;
  try {
    bytes = decodeBase32(input.capability);
  } catch {
    return null;
  }
  if (bytes.length !== 23 + PREVIEW_SIGNATURE_BYTES) return null;

  const body = bytes.subarray(0, 23);
  const suppliedSignature = bytes.subarray(23);
  const expectedSignature = signBytes(
    "goat-coding-workspace-preview-capability",
    body,
    input.secret,
  ).subarray(0, PREVIEW_SIGNATURE_BYTES);
  if (!timingSafeEqual(expectedSignature, suppliedSignature)) return null;
  const version = body.readUInt8(0);
  const codingSessionPrefix =
    version === PREVIEW_CAPABILITY_VERSION
      ? CODING_SESSION_PREFIX
      : version === LEGACY_PREVIEW_CAPABILITY_VERSION
        ? LEGACY_CODING_SESSION_PREFIX
        : null;
  if (!codingSessionPrefix) return null;

  const port = body.readUInt16BE(17);
  const expiresAt = body.readUInt32BE(19) * 1_000;
  if (!isPreviewPort(port) || expiresAt <= (input.now ?? Date.now())) return null;

  return {
    codingSessionId: `${codingSessionPrefix}${formatUuid(body.subarray(1, 17))}`,
    port,
    expiresAt,
  };
}

function encodeBase32(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return encoded;
}

function decodeBase32(encoded: string) {
  if (!encoded || encoded !== encoded.toLowerCase() || !/^[a-z2-7]+$/.test(encoded)) {
    throw new Error("Invalid base32 value.");
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of encoded) {
    const index = BASE32_ALPHABET.indexOf(character);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) throw new Error("Invalid base32 padding.");
  return Buffer.from(bytes);
}

function parseCodingSessionUuid(sessionId: string) {
  const prefix = sessionId.startsWith(CODING_SESSION_PREFIX)
    ? CODING_SESSION_PREFIX
    : sessionId.startsWith(LEGACY_CODING_SESSION_PREFIX)
      ? LEGACY_CODING_SESSION_PREFIX
      : null;
  const uuid = prefix ? sessionId.slice(prefix.length) : "";
  const hex = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error("Coding workspace session id does not contain a valid UUID.");
  }
  return {
    uuidBytes: Buffer.from(hex, "hex"),
    version:
      prefix === CODING_SESSION_PREFIX
        ? PREVIEW_CAPABILITY_VERSION
        : LEGACY_PREVIEW_CAPABILITY_VERSION,
  };
}

function hasCodingSessionPrefix(sessionId: string) {
  return (
    sessionId.startsWith(CODING_SESSION_PREFIX) ||
    sessionId.startsWith(LEGACY_CODING_SESSION_PREFIX)
  );
}

function formatUuid(bytes: Uint8Array) {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertPreviewPort(port: number) {
  if (!isPreviewPort(port)) throw new Error("Preview port must be between 1 and 65535.");
}

function isPreviewPort(port: number) {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function sign(namespace: string, value: string, secret: string) {
  return signBytes(namespace, Buffer.from(value), secret).toString("base64url");
}

function signBytes(namespace: string, value: Uint8Array, secret: string) {
  return createHmac("sha256", secret).update(namespace).update("\0").update(value).digest();
}

function safeEqual(expected: string, actual: string) {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
