export function parseBrowserOrigins(value: string | undefined) {
  if (!value?.trim()) return [];
  return [...new Set(value.split(",").map(parseBrowserOrigin))];
}

function parseBrowserOrigin(value: string) {
  const candidate = value.trim();
  if (!candidate) throw new Error("API_BROWSER_ORIGINS contains an empty origin.");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`API_BROWSER_ORIGINS contains an invalid origin: ${candidate}`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`API_BROWSER_ORIGINS must contain HTTP origins only: ${candidate}`);
  }
  return url.origin;
}
