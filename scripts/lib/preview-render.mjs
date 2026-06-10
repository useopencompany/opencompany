// Render API client for per-PR preview services (issue #351). The production release
// path (scripts/render-release.mjs) only *deploys an existing* service; previews must
// CREATE and DESTROY services per PR, so this adds create/find/delete/deploy + the
// service payload builders.
//
// ⚠️ NEEDS-LIVE-VALIDATION: the exact POST /v1/services body is centralized in the
// build*ServiceSpec() functions below. Render's create-service schema has evolved and
// could not be fully confirmed from public docs; validate these payloads against your
// Render account with `--dry-run` (which prints them verbatim) before the first real run,
// and tweak field names in ONE place if Render rejects them.

const RENDER_API_URL = process.env.RENDER_API_URL?.trim() || "https://api.render.com/v1";

const TERMINAL_OK = new Set(["live"]);
const TERMINAL_FAIL = new Set([
  "build_failed",
  "update_failed",
  "canceled",
  "pre_deploy_failed",
  "deactivated",
]);

export function createRenderClient({
  apiKey,
  apiUrl = RENDER_API_URL,
  fetchImpl = fetch,
  timeoutMs = 60_000,
} = {}) {
  if (!apiKey) throw new Error("RENDER_API_KEY is required.");

  async function request(path, init = {}, { allowEmpty = false } = {}) {
    let response;
    try {
      response = await fetchImpl(`${apiUrl}${path}`, {
        ...init,
        // Abort a stalled call rather than blocking provision/teardown until the
        // whole GitHub job times out (which could leave partial preview resources).
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new Error(`Render API request to ${path} timed out after ${timeoutMs}ms.`);
      }
      throw new Error(`Render API request failed: ${error?.cause?.message ?? error.message}`);
    }
    const text = await response.text();
    const payload = text ? safeJson(text) : null;
    if (!response.ok) {
      const detail = payload ? JSON.stringify(payload) : text.slice(0, 300);
      throw new Error(`Render API ${response.status} ${response.statusText}: ${detail}`);
    }
    if (!payload && allowEmpty) return null;
    return payload;
  }

  return {
    request,
    /** Find a service by exact name (Render names are unique per workspace). */
    async findServiceByName(name) {
      const result = await request(`/services?name=${encodeURIComponent(name)}&limit=20`);
      const items = Array.isArray(result) ? result.map((it) => it.service ?? it) : [];
      return items.find((svc) => svc?.name === name) ?? null;
    },
    /** List every preview-tagged service (reaper "actual" state). */
    async listPreviewServices() {
      const result = await request(`/services?limit=100`);
      const items = Array.isArray(result) ? result.map((it) => it.service ?? it) : [];
      return items.filter((svc) => serviceHasPreviewTag(svc));
    },
    async createService(spec) {
      const created = await request(`/services`, { method: "POST", body: JSON.stringify(spec) });
      // Create responses wrap the service (and sometimes a deploy) — normalize.
      return {
        service: created?.service ?? created,
        deployId: created?.deployId ?? created?.deploy?.id,
      };
    },
    async getService(id) {
      const result = await request(`/services/${id}`);
      return result?.service ?? result;
    },
    // Resolve the workspace owner id required by create-service. Avoids configuring
    // RENDER_OWNER_ID by hand when the API key belongs to a single workspace.
    async resolveOwnerId() {
      const result = await request(`/owners?limit=20`);
      const owners = Array.isArray(result) ? result.map((it) => it.owner ?? it) : [];
      if (owners.length === 0) throw new Error("Render API returned no owners for this API key.");
      if (owners.length > 1) {
        const names = owners.map((o) => `${o.name ?? "?"} (${o.id})`).join(", ");
        throw new Error(
          `Render API key has multiple owners; set RENDER_OWNER_ID. Options: ${names}`,
        );
      }
      return owners[0].id;
    },
    async deleteService(id) {
      await request(`/services/${id}`, { method: "DELETE" }, { allowEmpty: true });
    },
    /**
     * Configure a resource-level log stream override. Render documents this for
     * servers/cron jobs/databases/Redis at PUT /logs/streams/resource/{resourceId};
     * the override takes precedence over the workspace default stream.
     */
    async updateResourceLogStream(id, { endpoint, token, setting = "send" }) {
      await request(`/logs/streams/resource/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(compact({ endpoint, token, setting })),
      });
    },
    /** Replace the full env-var set (idempotent re-provision on PR synchronize). */
    async replaceEnvVars(id, envVars) {
      await request(`/services/${id}/env-vars`, {
        method: "PUT",
        body: JSON.stringify(envVars),
      });
    },
    async triggerDeploy(id, { clearCache = false } = {}) {
      const result = await request(`/services/${id}/deploys`, {
        method: "POST",
        body: JSON.stringify(clearCache ? { clearCache: "clear" } : {}),
      });
      return result?.deploy ?? result;
    },
    async getDeploy(serviceId, deployId) {
      const result = await request(`/services/${serviceId}/deploys/${deployId}`);
      return result?.deploy ?? result;
    },
    async waitForDeploy(
      serviceId,
      deployId,
      { timeoutMs = 900_000, pollMs = 10_000, sleep = defaultSleep } = {},
    ) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        const deploy = await this.getDeploy(serviceId, deployId);
        last = deploy?.status ?? "unknown";
        if (TERMINAL_OK.has(last)) return deploy;
        if (TERMINAL_FAIL.has(last)) {
          throw new Error(`Render deploy ${deployId} (service ${serviceId}) failed: ${last}.`);
        }
        await sleep(pollMs);
      }
      throw new Error(`Render deploy ${deployId} did not finish in time. Last status: ${last}.`);
    },
  };
}

// --- pure payload builders (unit-tested) ---------------------------------------

/** Convert a flat env object to Render's envVars array shape. */
export function toRenderEnvVars(envObj = {}) {
  return Object.entries(envObj).map(([key, value]) => ({ key, value: String(value) }));
}

/** True if a Render service object carries our preview tag (reaper discovery + safety). */
export function serviceHasPreviewTag(service) {
  const tags = service?.serviceDetails?.tags ?? service?.tags ?? [];
  return Array.isArray(tags) && tags.includes("opencompany-preview");
}

/**
 * The per-PR RUNNER service: builds Dockerfile.runner from this repo at the PR branch,
 * autoDeploy off (the orchestrator triggers deploys for the exact SHA).
 */
export function buildRunnerServiceSpec({
  name,
  ownerId,
  repo,
  branch,
  env,
  plan = "starter",
  region = "frankfurt",
}) {
  return {
    type: "web_service",
    name,
    ownerId,
    repo,
    branch,
    autoDeploy: "no",
    serviceDetails: {
      env: "docker",
      plan,
      region,
      healthCheckPath: "/healthz",
      tags: ["opencompany-preview"],
      envSpecificDetails: { dockerfilePath: "./Dockerfile.runner" },
    },
    envVars: toRenderEnvVars(env),
  };
}

/** The per-PR ELECTRIC service: runs the public electricsql/electric image. */
export function buildElectricServiceSpec({
  name,
  ownerId,
  image = "docker.io/electricsql/electric:latest",
  env,
  plan = "starter",
  region = "frankfurt",
}) {
  return {
    type: "web_service",
    name,
    ownerId,
    image: { imagePath: image },
    autoDeploy: "no",
    serviceDetails: {
      env: "image",
      plan,
      region,
      healthCheckPath: "/v1/health",
      tags: ["opencompany-preview"],
    },
    envVars: toRenderEnvVars(env),
  };
}

/**
 * The per-PR DURABLE STREAMS service: runs the in-memory reference server from this repo.
 * In-memory is acceptable — the transcript is persisted in Postgres (design §4.5).
 */
export function buildStreamsServiceSpec({
  name,
  ownerId,
  repo,
  branch,
  env = {},
  plan = "starter",
  region = "frankfurt",
}) {
  return {
    type: "web_service",
    name,
    ownerId,
    repo,
    branch,
    autoDeploy: "no",
    serviceDetails: {
      env: "node",
      plan,
      region,
      tags: ["opencompany-preview"],
      envSpecificDetails: {
        buildCommand: "bun install --frozen-lockfile",
        startCommand: "bun scripts/durable-streams-dev.mjs",
      },
    },
    envVars: toRenderEnvVars(env),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
