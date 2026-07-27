export const BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_wait",
  "browser_read",
  "browser_get",
  "browser_find",
  "browser_scroll",
  "browser_screenshot",
  "browser_close",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

const BROWSER_TOOL_NAME_SET = new Set<BrowserToolName>(BROWSER_TOOL_NAMES);

export function isBrowserToolName(name: string): name is BrowserToolName {
  return BROWSER_TOOL_NAME_SET.has(name as BrowserToolName);
}
