import type { BrowserToolName } from "./names";

export const BROWSER_TOOL_DESCRIPTIONS = {
  browser_open:
    "Open a rendered browser page at an absolute http(s) URL in the isolated browser session. Read/research only: never log in, check out, purchase, mutate accounts, or handle credentials.",
  browser_snapshot:
    "Return a compact accessibility snapshot of the active rendered browser page, with element refs like @e1 for later browser_click or browser_fill calls. Use includeUrls=true only when direct link URLs are needed.",
  browser_click:
    "Click one element by a browser_snapshot ref like @e1. Use only for read/research navigation, filters, sorting, tabs, consent dismissal, or non-destructive interaction.",
  browser_fill:
    "Fill one input by a browser_snapshot ref like @e1. Use for search boxes and read-only filters only; never enter credentials, payment details, or private user data.",
  browser_wait:
    "Wait briefly for browser page state: milliseconds, an element ref, text, URL pattern, or load state.",
  browser_read:
    "Read text from either the active rendered browser page or an absolute http(s) URL. Optionally filter returned lines by text. Prefer this over snapshots when page text is the main evidence.",
  browser_get:
    "Get one targeted value from the active browser page: url, title, text, value, attr, or count. Prefer this over snapshots when you know what to inspect. For direct URLs from link refs, use target attr with attribute href.",
  browser_find:
    "Use semantic locators to find or act on one element without taking a broad snapshot. Supports role, text, label, placeholder, alt, title, testid, first, last, and nth.",
  browser_scroll:
    "Scroll the active browser viewport up, down, left, or right. Use before a scoped follow-up snapshot or targeted get when content is below the fold.",
  browser_screenshot:
    "Capture a screenshot of the active browser page for traceability. The model receives the textual tool result, not visual access to the screenshot pixels.",
  browser_close:
    "Close the isolated browser session. Usually unnecessary because the sandbox lifecycle bounds the session.",
} as const satisfies Record<BrowserToolName, string>;

export const BROWSER_TOOL_INPUT_SCHEMAS = {
  browser_open: {
    type: "object",
    additionalProperties: false,
    properties: { url: { type: "string" } },
    required: ["url"],
  },
  browser_snapshot: {
    type: "object",
    additionalProperties: false,
    properties: {
      interactive: { type: "boolean" },
      includeUrls: { type: "boolean" },
      compact: { type: "boolean" },
      depth: { type: "number", minimum: 1, maximum: 10 },
      selector: { type: "string" },
    },
  },
  browser_click: {
    type: "object",
    additionalProperties: false,
    properties: { ref: { type: "string" } },
    required: ["ref"],
  },
  browser_fill: {
    type: "object",
    additionalProperties: false,
    properties: { ref: { type: "string" }, text: { type: "string" } },
    required: ["ref", "text"],
  },
  browser_wait: {
    type: "object",
    additionalProperties: false,
    properties: {
      milliseconds: { type: "number", minimum: 100, maximum: 30000 },
      ref: { type: "string" },
      text: { type: "string" },
      urlPattern: { type: "string" },
      loadState: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] },
    },
  },
  browser_read: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string" },
      filter: { type: "string" },
      outline: { type: "boolean" },
    },
  },
  browser_get: {
    type: "object",
    additionalProperties: false,
    properties: {
      target: { type: "string", enum: ["url", "title", "text", "value", "attr", "count"] },
      ref: { type: "string" },
      selector: { type: "string" },
      attribute: { type: "string" },
    },
    required: ["target"],
  },
  browser_find: {
    type: "object",
    additionalProperties: false,
    properties: {
      by: {
        type: "string",
        enum: [
          "role",
          "text",
          "label",
          "placeholder",
          "alt",
          "title",
          "testid",
          "first",
          "last",
          "nth",
        ],
      },
      value: { type: "string" },
      action: {
        type: "string",
        enum: ["click", "fill", "type", "hover", "focus", "check", "uncheck"],
      },
      text: { type: "string" },
      name: { type: "string" },
      exact: { type: "boolean" },
      index: { type: "number", minimum: 0, maximum: 10000 },
    },
    required: ["by", "value", "action"],
  },
  browser_scroll: {
    type: "object",
    additionalProperties: false,
    properties: {
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      pixels: { type: "number", minimum: 1, maximum: 5000 },
    },
    required: ["direction"],
  },
  browser_screenshot: {
    type: "object",
    additionalProperties: false,
    properties: {
      fullPage: { type: "boolean" },
      annotate: { type: "boolean" },
    },
  },
  browser_close: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
} as const satisfies Record<BrowserToolName, object>;
