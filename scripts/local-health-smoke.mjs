// Verifies the two backend composition roots used by local web development.

const attempts = positiveInteger(process.env.OPENCOMPANY_SMOKE_ATTEMPTS, 30);
const delayMs = positiveInteger(process.env.OPENCOMPANY_SMOKE_DELAY_MS, 500);
const conductorPort = optionalPort(process.env.CONDUCTOR_PORT);

const targets = [
  {
    name: "API",
    service: "opencompany-api",
    urls: candidates(process.env.OPENCOMPANY_API_URL, [
      ...(conductorPort ? [`http://127.0.0.1:${conductorPort + 4}`] : []),
      "http://127.0.0.1:3001",
    ]),
  },
  {
    name: "runner",
    service: "opencompany-runner",
    urls: candidates(process.env.OPENCOMPANY_RUNNER_URL ?? process.env.RUNNER_PUBLIC_URL, [
      ...(conductorPort ? [`http://127.0.0.1:${conductorPort + 1}`] : []),
      "http://127.0.0.1:3040",
    ]),
  },
];

await Promise.all(targets.map(checkTarget));
console.log("Local API and runner health checks passed.");

async function checkTarget(target) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (const baseUrl of target.urls) {
      const url = new URL("/healthz", baseUrl);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        const body = await response.json();
        if (!response.ok || body?.ok !== true || body?.service !== target.service) {
          throw new Error(`unexpected response (${response.status})`);
        }
        console.log(`${target.name}: ${url} (${body.mode ?? body.environment ?? "unknown mode"})`);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(
    `${target.name} health check failed at ${target.urls.join(" or ")}: ${lastError?.message ?? "unknown error"}`,
  );
}

function candidates(configured, fallbacks) {
  const values = [configured?.trim(), ...fallbacks].filter(Boolean);
  return [...new Set(values.map(normalizeOrigin))];
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`Invalid local health origin: ${value}`);
  }
  return url.origin;
}

function positiveInteger(raw, fallback) {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error("Smoke timing values must be positive integers.");
  return value;
}

function optionalPort(raw) {
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value <= 65_531 ? value : null;
}
