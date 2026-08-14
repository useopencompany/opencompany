export function resolveApiPort(env: Record<string, string | undefined>) {
  const value = Number(localApiPort(env.OPENCOMPANY_API_ORIGIN) ?? env.PORT ?? "3001");
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(
      "The local OPENCOMPANY_API_ORIGIN port or PORT must be an integer from 1 to 65535.",
    );
  }
  return value;
}

function localApiPort(origin: string | undefined) {
  if (!origin?.trim()) return null;
  try {
    const url = new URL(origin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
    ) {
      return null;
    }
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return null;
  }
}
