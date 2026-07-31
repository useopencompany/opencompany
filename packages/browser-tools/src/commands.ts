import type { BrowserToolName } from "./names";

export const AGENT_BROWSER_MAX_OUTPUT = 20_000;

type BrowserArgvInput = {
  name: BrowserToolName;
  args: unknown;
  sessionId: string;
  actionPolicyPath: string;
  cdpUrl?: string;
  allowedHosts?: readonly string[];
  screenshotPath?: string;
};

export function buildBrowserToolArgv(input: BrowserArgvInput): string[] {
  const argv = baseArgv(input);

  switch (input.name) {
    case "browser_open": {
      const record = asRecord(input.args);
      argv.push("open", readHttpUrl(record, "url", "browser_open url", input.allowedHosts));
      return argv;
    }
    case "browser_snapshot": {
      const record = asRecord(input.args);
      argv.push("snapshot");
      if (readOptionalBoolean(record, "interactive") ?? true) argv.push("-i");
      if (readOptionalBoolean(record, "compact") ?? true) argv.push("-c");
      argv.push("-d", String(readDepth(record, 5)));
      const selector = readOptionalString(record, "selector");
      if (selector) argv.push("-s", selector);
      if (readOptionalBoolean(record, "includeUrls")) argv.push("--urls");
      return argv;
    }
    case "browser_click": {
      const record = asRecord(input.args);
      argv.push("click", readRef(record, "ref"));
      return argv;
    }
    case "browser_fill": {
      const record = asRecord(input.args);
      argv.push("fill", readRef(record, "ref"), readRequiredString(record, "text"));
      return argv;
    }
    case "browser_wait": {
      const record = asRecord(input.args);
      argv.push("wait");
      const milliseconds = readOptionalNumber(record, "milliseconds");
      const ref = readOptionalString(record, "ref");
      const text = readOptionalString(record, "text");
      const urlPattern = readOptionalString(record, "urlPattern");
      const loadState = readOptionalString(record, "loadState");
      if (milliseconds !== undefined) {
        argv.push(String(clampInteger(milliseconds, 100, 30_000)));
      } else if (ref) {
        argv.push(normalizeRef(ref));
      } else if (text) {
        argv.push("--text", text);
      } else if (urlPattern) {
        argv.push("--url", urlPattern);
      } else if (loadState) {
        if (!["load", "domcontentloaded", "networkidle"].includes(loadState)) {
          throw new Error("browser_wait loadState must be load, domcontentloaded, or networkidle.");
        }
        argv.push("--load", loadState);
      } else {
        argv.push("1000");
      }
      return argv;
    }
    case "browser_read":
      argv.push("get", "text", "body");
      return argv;
    case "browser_get": {
      const record = asRecord(input.args);
      const target = readBrowserGetTarget(record);
      argv.push("get", target);
      const selector = readOptionalRefOrSelector(record);
      if (selector) {
        argv.push(selector);
      } else if (target === "text") {
        argv.push("body");
      }
      if (target === "attr") {
        argv.push(readRequiredString(record, "attribute"));
      }
      return argv;
    }
    case "browser_find": {
      const record = asRecord(input.args);
      argv.push("find", readFindBy(record));
      const nth = readOptionalNumber(record, "index");
      if (readOptionalString(record, "by") === "nth") {
        if (nth === undefined) throw new Error("browser_find index is required when by is nth.");
        argv.push(String(clampInteger(nth, 0, 10_000)));
      }
      argv.push(readRequiredString(record, "value"), readFindAction(record));
      const text = readOptionalString(record, "text");
      if (text) argv.push(text);
      const name = readOptionalString(record, "name");
      if (name) argv.push("--name", name);
      if (readOptionalBoolean(record, "exact")) argv.push("--exact");
      return argv;
    }
    case "browser_scroll": {
      const record = asRecord(input.args);
      argv.push("scroll", readScrollDirection(record), String(readScrollPixels(record)));
      return argv;
    }
    case "browser_screenshot": {
      const record = asRecord(input.args);
      argv.push("screenshot");
      if (readOptionalBoolean(record, "fullPage")) argv.push("--full");
      if (readOptionalBoolean(record, "annotate")) argv.push("--annotate");
      if (input.screenshotPath) argv.push(input.screenshotPath);
      return argv;
    }
    case "browser_close":
      argv.push("close");
      return argv;
  }
}

export function buildBrowserReadArgv(input: Omit<BrowserArgvInput, "name" | "screenshotPath">) {
  const record = asRecord(input.args);
  const argv = [...baseArgv(input), "read"];
  const url = readOptionalString(record, "url");
  if (url) argv.push(readHttpUrl(record, "url", "browser_read url", input.allowedHosts));
  const filter = readOptionalString(record, "filter");
  if (filter) argv.push("--filter", filter);
  if (readOptionalBoolean(record, "outline")) argv.push("--outline");
  return argv;
}

function baseArgv(input: Pick<BrowserArgvInput, "sessionId" | "actionPolicyPath" | "cdpUrl">) {
  const argv = [
    "--session",
    input.sessionId,
    "--content-boundaries",
    "--max-output",
    String(AGENT_BROWSER_MAX_OUTPUT),
    "--action-policy",
    input.actionPolicyPath,
  ];
  if (input.cdpUrl) argv.push("--cdp", input.cdpUrl);
  return argv;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readHttpUrl(
  record: Record<string, unknown>,
  key: string,
  label: string,
  allowedHosts?: readonly string[],
) {
  const value = readRequiredString(record, key);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials.`);
  }
  if (allowedHosts?.length && !urlHostAllowed(url.hostname, allowedHosts)) {
    throw new Error(`${label} is outside the active browser profile's allowed domains.`);
  }
  return url.toString();
}

export function urlHostAllowed(hostname: string, allowedHosts: readonly string[]) {
  const normalized = normalizeHostname(hostname);
  return allowedHosts.some((allowed) => {
    const host = normalizeHostname(allowed);
    return normalized === host || normalized.endsWith(`.${host}`);
  });
}

export function normalizeRef(value: string) {
  const ref = value.trim();
  if (!/^@?e\d+$/.test(ref)) {
    throw new Error("Browser element refs must look like @e1.");
  }
  return ref.startsWith("@") ? ref : `@${ref}`;
}

export function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readDepth(record: Record<string, unknown>, defaultValue: number) {
  const value = readOptionalNumber(record, "depth");
  return value === undefined ? defaultValue : clampInteger(value, 1, 10);
}

function readBrowserGetTarget(record: Record<string, unknown>) {
  const target = readRequiredString(record, "target");
  if (!["url", "title", "text", "value", "attr", "count"].includes(target)) {
    throw new Error("browser_get target must be url, title, text, value, attr, or count.");
  }
  if (target === "attr") readRequiredString(record, "attribute");
  if (["text", "value", "attr", "count"].includes(target)) {
    const selector = readOptionalRefOrSelector(record);
    if (!selector && target !== "text") {
      throw new Error(`browser_get ${target} requires ref or selector.`);
    }
  }
  return target;
}

function readOptionalRefOrSelector(record: Record<string, unknown>) {
  const ref = readOptionalString(record, "ref");
  if (ref) return normalizeRef(ref);
  return readOptionalString(record, "selector");
}

function readFindBy(record: Record<string, unknown>) {
  const by = readRequiredString(record, "by");
  if (
    ![
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
    ].includes(by)
  ) {
    throw new Error(
      "browser_find by must be role, text, label, placeholder, alt, title, testid, first, last, or nth.",
    );
  }
  return by;
}

function readFindAction(record: Record<string, unknown>) {
  const action = readRequiredString(record, "action");
  if (!["click", "fill", "type", "hover", "focus", "check", "uncheck"].includes(action)) {
    throw new Error(
      "browser_find action must be click, fill, type, hover, focus, check, or uncheck.",
    );
  }
  if (action === "fill" || action === "type") readRequiredString(record, "text");
  return action;
}

function readScrollDirection(record: Record<string, unknown>) {
  const direction = readRequiredString(record, "direction");
  if (!["up", "down", "left", "right"].includes(direction)) {
    throw new Error("browser_scroll direction must be up, down, left, or right.");
  }
  return direction;
}

function readScrollPixels(record: Record<string, unknown>) {
  return clampInteger(readOptionalNumber(record, "pixels") ?? 800, 1, 5000);
}

function readRef(record: Record<string, unknown>, key: string) {
  return normalizeRef(readRequiredString(record, key));
}

function readRequiredString(record: Record<string, unknown>, key: string) {
  const value = readOptionalString(record, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function normalizeHostname(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(Math.max(Math.floor(value), min), max);
}
