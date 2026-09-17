import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { authorizePersistedExternalEngineToolCapability } from "@opencompany/agent/application/persisted-external-engine-capability";
import {
  GitHubUserAccessAuthError,
  getGitHubUserAccessToken,
  loadGitHubUserIntegration,
} from "@opencompany/agent/integrations/github-user";
import {
  createExternalEngineGatewayTicket,
  verifyExternalEngineGatewayTicket,
} from "@opencompany/agent-runtime";
import { createLogger } from "@opencompany/observability";
import type { FastifyInstance } from "fastify";
import { gitAuthHeader } from "./coding-agent-shared";

const logger = createLogger({ service: "opencompany-runner", runtime: "github-broker" });
export const GITHUB_BROKER_HOSTS = ["api.github.com", "github.com", "uploads.github.com"] as const;
export const GITHUB_BROKER_BODY_LIMIT = 128 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10 * 60_000;
const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "content-encoding",
  "user-agent",
  "git-protocol",
  "graphql-features",
  "time-zone",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "range",
  "x-github-api-version",
] as const;
const RESPONSE_HEADERS = [
  "content-type",
  "location",
  "link",
  "etag",
  "last-modified",
  "retry-after",
  "accept-ranges",
  "content-range",
  "x-github-request-id",
  "x-oauth-scopes",
  "x-accepted-oauth-scopes",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-resource",
] as const;

// A tool ticket must not grant raw GitHub access (or vice versa). Reuse the existing
// attempt/lease payload and verifier with a distinct signing domain.
function githubSigningSecret(secret: string) {
  return createHmac("sha256", secret).update("opencompany-github-broker-v1").digest("hex");
}
export function createGitHubBrokerTicket(
  input: Parameters<typeof createExternalEngineGatewayTicket>[0],
) {
  return createExternalEngineGatewayTicket({ ...input, secret: githubSigningSecret(input.secret) });
}

export type GitHubBrokerDependencies = {
  authorize: typeof authorizePersistedExternalEngineToolCapability;
  loadIntegration: typeof loadGitHubUserIntegration;
  getAccessToken: typeof getGitHubUserAccessToken;
  fetch: typeof fetch;
};

export function registerGitHubBrokerRoutes(
  app: FastifyInstance,
  input: { secret: string; dependencies?: Partial<GitHubBrokerDependencies> },
) {
  const deps: GitHubBrokerDependencies = {
    authorize: authorizePersistedExternalEngineToolCapability,
    loadIntegration: loadGitHubUserIntegration,
    getAccessToken: getGitHubUserAccessToken,
    fetch,
    ...input.dependencies,
  };
  const capabilityFor = (value: unknown) => {
    const capability =
      typeof value === "string"
        ? verifyExternalEngineGatewayTicket({
            ticket: value,
            secret: githubSigningSecret(input.secret),
          })
        : null;
    return capability?.v === 2 ? capability : null;
  };
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: GITHUB_BROKER_BODY_LIMIT },
      (_request, body, done) => done(null, body),
    );
    scope.route<{ Params: { host: string; "*": string } }>({
      method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      url: "/broker/github/:host/*",
      bodyLimit: GITHUB_BROKER_BODY_LIMIT,
      // Reject missing/expired capabilities before buffering a potentially large packfile.
      onRequest: async (request, reply) => {
        if (!capabilityFor(request.headers["x-opencompany-github-ticket"])) {
          return reply
            .header("cache-control", "no-store")
            .code(401)
            .send({ message: "Invalid GitHub broker capability." });
        }
      },
      handler: async (request, reply) => {
        reply.header("cache-control", "no-store");
        const capability = capabilityFor(request.headers["x-opencompany-github-ticket"]);
        if (!capability) {
          return reply.code(401).send({ message: "Invalid GitHub broker capability." });
        }
        const { host } = request.params;
        if (!GITHUB_BROKER_HOSTS.some((allowed) => allowed === host)) {
          return reply.code(400).send({ message: "Unsupported GitHub host." });
        }
        // Use the raw suffix, preserving percent encoding and query strings. The host
        // comes exclusively from the allowlist, never from a client-provided URL.
        const prefix = `/broker/github/${host}/`;
        if (!request.raw.url?.startsWith(prefix)) {
          return reply.code(400).send({ message: "Invalid GitHub request path." });
        }
        const suffix = request.raw.url.slice(prefix.length);
        const url = new URL(`https://${host}/${suffix}`);
        if (url.hostname !== host || url.protocol !== "https:" || url.username || url.password) {
          return reply.code(400).send({ message: "Invalid GitHub request URL." });
        }
        const controller = new AbortController();
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        ]);
        const abort = () => controller.abort();
        request.raw.once("aborted", abort);
        reply.raw.once("close", abort);
        try {
          const authorized = await deps.authorize({ capability });
          if (!authorized)
            return reply.code(403).send({ message: "This engine attempt is no longer active." });
          const integration = await deps.loadIntegration({ userWorkosId: authorized.actorId });
          if (!integration || integration.status !== "connected") {
            return reply.code(403).send({ message: "Reconnect GitHub in Settings." });
          }
          const connection = { userWorkosId: authorized.actorId, integrationId: integration.id };
          let token = await deps.getAccessToken(connection, { signal });
          const headers = new Headers();
          for (const name of REQUEST_HEADERS) {
            const value = request.headers[name];
            if (typeof value === "string") headers.set(name, value);
          }
          headers.set("accept-encoding", "identity");
          const send = () => {
            headers.set(
              "authorization",
              host === "github.com"
                ? gitAuthHeader(token).slice("Authorization: ".length)
                : `Bearer ${token}`,
            );
            return deps.fetch(url, {
              method: request.method,
              headers,
              redirect: "manual",
              signal,
              ...(request.method !== "GET" &&
              request.method !== "HEAD" &&
              Buffer.isBuffer(request.body)
                ? { body: new Uint8Array(request.body) }
                : {}),
            });
          };
          let response = await send();
          if (response.status === 401) {
            await response.body?.cancel();
            // A 401 rejected this HTTP request before authorization. Retry this request
            // once, never an entire CLI command, a transport failure, or a 403/5xx.
            const current = await deps.authorize({ capability });
            const connected =
              current && (await deps.loadIntegration({ userWorkosId: current.actorId }));
            if (
              !current ||
              current.actorId !== authorized.actorId ||
              !connected ||
              connected.id !== integration.id ||
              connected.status !== "connected"
            ) {
              return reply.code(403).send({ message: "GitHub access is no longer active." });
            }
            token = await deps.getAccessToken(connection, { signal, refreshIfAccessToken: token });
            logger.info("Retrying a GitHub request after credential rejection", {
              event: "opencompany.github_broker_credential_rejected",
              turn_id: capability.codexChatTurnId,
              attempt_id: capability.attemptId,
              integration_id: integration.id,
            });
            response = await send();
          }
          reply.code(response.status);
          for (const name of RESPONSE_HEADERS) {
            const value = response.headers.get(name);
            if (value) reply.header(name, value);
          }
          // Fetch can decompress responses. Do not forward the upstream length or encoding.
          if (!response.body || request.method === "HEAD") return reply.send();
          return reply.send(
            Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
          );
        } catch (error) {
          logger.warn("GitHub broker request failed", {
            event: "opencompany.github_broker_request_failed",
            turn_id: capability.codexChatTurnId,
            attempt_id: capability.attemptId,
            error_name: error instanceof Error ? error.name : typeof error,
          });
          return reply.code(error instanceof GitHubUserAccessAuthError ? 403 : 502).send({
            message:
              error instanceof GitHubUserAccessAuthError
                ? "Reconnect GitHub in Settings."
                : "GitHub request could not be completed.",
          });
        }
      },
    });
  });
}
