import { PROTOCOL_VERSION_HEADER } from "./version";

/**
 * Request headers supported by first-party browser clients of the canonical `/v1` API.
 *
 * The API CORS middleware consumes this transport contract directly. Protocol tests verify that
 * every header declared by an OpenAPI operation remains covered, so adding a route header cannot
 * produce a browser-only failure at runtime.
 */
export const V1_BROWSER_REQUEST_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "Idempotency-Key",
  "If-None-Match",
  "Last-Event-ID",
  PROTOCOL_VERSION_HEADER,
] as const;
