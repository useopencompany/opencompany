#!/usr/bin/env node

const baseUrl = normalizeBaseUrl(process.env.PRODUCTION_WEB_URL || process.env.WEB_URL);
const targetUrl =
  normalizeEndpoint(process.env.INNGEST_SYNC_URL) || normalizeEndpoint("/api/inngest");
const attempts = Number(process.env.INNGEST_SYNC_ATTEMPTS ?? "6");
const delayMs = Number(process.env.INNGEST_SYNC_DELAY_MS ?? "10000");

if (!targetUrl) {
  console.error("PRODUCTION_WEB_URL, WEB_URL, or INNGEST_SYNC_URL is required.");
  process.exit(1);
}

await syncUntilReady(targetUrl, attempts, delayMs);

async function syncUntilReady(url, maxAttempts, waitMs) {
  let lastError;

  console.log(`Inngest sync target: ${url}`);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { Accept: "application/json,text/plain,*/*" },
        cache: "no-store",
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`${response.status} ${body.slice(0, 500)}`);
      }

      console.log(`Inngest sync passed: ${url}`);
      if (body.trim()) {
        console.log(body.slice(0, 1000));
      }
      return;
    } catch (error) {
      lastError = error;
      console.log(`Inngest sync attempt ${attempt}/${maxAttempts} failed: ${error.message}`);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  throw new Error(`Inngest sync failed after ${maxAttempts} attempts: ${lastError.message}`);
}

function normalizeBaseUrl(value) {
  return value?.replace(/\/+$/, "") || "";
}

function normalizeEndpoint(value) {
  if (!value) return "";
  const raw = value.trim();
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw.replace(/\/+$/, "");
  }

  if (!baseUrl) return "";
  return `${baseUrl}${raw.startsWith("/") ? raw : `/${raw}`}`;
}
