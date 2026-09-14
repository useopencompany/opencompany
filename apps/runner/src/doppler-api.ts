export class DopplerAuthRejected extends Error {
  constructor() {
    super("Doppler rejected the saved login. Reconnect in Settings → Plugins → Doppler.");
  }
}

/** Read identity only. Never return token previews or arbitrary provider error bodies. */
export async function validateDopplerToken(token: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch("https://api.doppler.com/v3/me", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    throw new Error("Doppler could not be reached. Please try again.");
  }
  if (response.status === 401 || response.status === 403) throw new DopplerAuthRejected();
  if (!response.ok) throw new Error("Doppler could not validate the connection. Please try again.");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("Doppler returned an invalid account response.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !value.name.trim()
  )
    throw new Error("Doppler returned an invalid account response.");
  return value.name.trim().slice(0, 256);
}
