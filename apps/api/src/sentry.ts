import { createHash } from "node:crypto";
import { SENTRY_TOOL_NAMES, sentryToolMode } from "@opencompany/agent/actions/sentry";
import {
  exchangeSentryGrant,
  SentryEnvelopeSchema,
  SentryProjectSchema,
  sentryAccessToken,
  sentryApi,
  sentryConfigured,
  sentryRequest,
  verifySentrySignature,
} from "@opencompany/agent/integrations/sentry";
import { validateWorkflowStepRepository } from "@opencompany/agent/workflow-step-repository";
import { type Actor, COMPANY_SENTRY_EVENTS } from "@opencompany/core";
import {
  integrations,
  sentryConnections,
  sentryWebhookReceipts,
} from "@opencompany/db/product-schema";
import {
  bindSentryConnection,
  disconnectSentry,
  findSentryInstallation,
  getSentryConnection,
  type SentryConnection,
  sentryRows,
} from "@opencompany/db/sentry";
import { listCompanyWorkflowEventTriggerRoutes } from "@opencompany/db/workflow-event-routes";
import {
  CompanySentryPluginSchema,
  SentryConnectBodySchema,
  type SentryFixSetupDto,
  SentrySettingsBodySchema,
} from "@opencompany/protocol";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "./errors";

type DbLike = any;
export const SentryConnectInput = SentryConnectBodySchema;
export const SentrySettingsInput = SentrySettingsBodySchema;
function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      400,
      "invalid_request",
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  return parsed.data as z.output<S>;
}
function requireAdmin(actor: Actor) {
  if (actor.role !== "admin")
    throw new ApiError(
      403,
      "forbidden",
      "Only workspace admins can manage Sentry connections and shared permissions.",
    );
}
// Locks the connection row and confirms it is still the installation the caller loaded.
async function lockCurrentConnection(tx: DbLike, actor: Actor, connection: SentryConnection) {
  await tx.execute(
    sql`SELECT integration_id FROM goat.sentry_connections WHERE integration_id = ${connection.integrationId} FOR UPDATE`,
  );
  const latest = await getSentryConnection(actor.workspaceId, tx);
  if (
    !latest ||
    latest.installationId !== connection.installationId ||
    latest.status === "disconnected"
  )
    throw new ApiError(409, "conflict", "Sentry disconnected while setup was in progress.");
}
export function createSentryService(db: DbLike) {
  async function get(actor: Actor) {
    const connection = await getSentryConnection(actor.workspaceId, db);
    const usage = connection
      ? (sentryRows<{ count: number }>(
          await db.execute(
            sql`SELECT count(*)::int AS count FROM goat.sentry_issue_runs WHERE workspace_id = ${actor.workspaceId} AND started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
          ),
        )[0]?.count ?? 0)
      : 0;
    // Derived from receipts so webhook ingress never writes the connection row.
    const lastReceivedAt = connection
      ? (sentryRows<{ receivedAt: string | Date | null }>(
          await db.execute(
            sql`SELECT max(received_at) AS "receivedAt" FROM goat.sentry_webhook_receipts WHERE installation_id = ${connection.installationId}`,
          ),
        )[0]?.receivedAt ?? null)
      : null;
    const outcomes = connection
      ? sentryRows(
          await db.execute(
            sql`SELECT receipt.id, receipt.received_at AS "receivedAt", receipt.status, receipt.reason, event.status AS "runStatus", event.last_error AS "runReason", run.issue_id AS "issueId", run.task_id AS "taskId" FROM goat.sentry_webhook_receipts receipt LEFT JOIN goat.sentry_issue_runs run ON run.receipt_id = receipt.id LEFT JOIN goat.workflow_event_runs event ON event.id = run.event_run_id WHERE receipt.installation_id = ${connection.installationId} ORDER BY receipt.received_at DESC LIMIT 20`,
          ),
        )
      : [];
    return CompanySentryPluginSchema.parse({
      configured: sentryConfigured(),
      canManage: actor.role === "admin",
      installUrl: sentryConfigured()
        ? `https://sentry.io/sentry-apps/${encodeURIComponent(process.env.SENTRY_APP_SLUG!)}/external-install/`
        : null,
      connection: connection
        ? {
            ...connection,
            verifiedAt: connection.verifiedAt?.toISOString() ?? null,
            lastReceivedAt: lastReceivedAt ? new Date(lastReceivedAt).toISOString() : null,
          }
        : null,
      tools: connection
        ? SENTRY_TOOL_NAMES.map((id) => ({ id, mode: sentryToolMode(connection, id) }))
        : [],
      events: COMPANY_SENTRY_EVENTS,
      usage,
      outcomes: outcomes.map((outcome) => ({
        ...(outcome as Record<string, unknown>),
        receivedAt: new Date((outcome as { receivedAt: string }).receivedAt).toISOString(),
      })),
    });
  }
  async function projects(actor: Actor, all = false, cursor?: string) {
    if (all) requireAdmin(actor);
    const connection = await getSentryConnection(actor.workspaceId, db);
    if (!connection || connection.status === "disconnected")
      throw new ApiError(409, "conflict", "Connect Sentry first.");
    const response = await sentryApi(
      connection,
      `organizations/${encodeURIComponent(connection.organizationSlug)}/projects/`,
      new URLSearchParams({ per_page: "100", ...(cursor ? { cursor } : {}) }),
      { db },
    );
    const data = z.array(SentryProjectSchema).parse(response.data);
    return {
      projects: all
        ? data
        : data.filter((project) => connection.selectedProjectIds.includes(project.id)),
      nextCursor: response.nextCursor,
    };
  }
  return {
    get,
    projects,
    async connect(actor: Actor, raw: unknown) {
      requireAdmin(actor);
      if (!sentryConfigured())
        throw new ApiError(
          503,
          "unavailable",
          "Sentry integration credentials are not configured.",
        );
      const input = parseInput(SentryConnectInput, raw);
      await db.transaction(async (tx: DbLike) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`sentry-install:${input.installationId}`}))`,
        );
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`sentry-workspace:${actor.workspaceId}`}))`,
        );
        const [owner] = await tx
          .select({ workspaceId: integrations.workspaceId })
          .from(integrations)
          .where(
            sql`${integrations.provider} = 'sentry' AND ${integrations.externalId} = ${input.installationId}`,
          )
          .limit(1);
        if (owner && owner.workspaceId !== actor.workspaceId)
          throw new ApiError(
            409,
            "conflict",
            "This Sentry installation belongs to another workspace.",
          );
        const bound = await findSentryInstallation(input.installationId, tx);
        if (bound && bound.workspaceId !== actor.workspaceId)
          throw new ApiError(
            409,
            "conflict",
            "This Sentry installation belongs to another workspace.",
          );
        const current = await getSentryConnection(actor.workspaceId, tx);
        if (
          current &&
          current.status !== "disconnected" &&
          current.installationId !== input.installationId
        )
          throw new ApiError(
            409,
            "conflict",
            "This workspace already has a Sentry organization. Disconnect it first.",
          );
        const tokens = await exchangeSentryGrant(input.installationId, input.code);
        if (new Date(tokens.expiresAt) <= new Date())
          throw new ApiError(409, "conflict", "Sentry returned expired installation credentials.");
        const response = await sentryRequest(
          "organizations/",
          new URLSearchParams(),
          tokens.token,
          input.region === "eu" ? "https://de.sentry.io/api/0/" : "https://us.sentry.io/api/0/",
        );
        const organizations = z
          .array(z.object({ id: z.string(), slug: z.string().regex(/^[a-zA-Z0-9_-]+$/) }))
          .parse(response.data);
        if (organizations.length !== 1)
          throw new ApiError(
            409,
            "conflict",
            "Sentry must authorize exactly one organization in the selected region.",
          );
        const organization = organizations[0]!;
        await bindSentryConnection({
          ...input,
          workspaceId: actor.workspaceId,
          userWorkosId: actor.userId,
          organizationId: organization.id,
          organizationSlug: organization.slug,
          token: tokens.token,
          refreshToken: tokens.refreshToken,
          expiresAt: new Date(tokens.expiresAt),
          db: tx,
        });
      });
      return get(actor);
    },
    async settings(actor: Actor, raw: unknown) {
      requireAdmin(actor);
      const input = parseInput(SentrySettingsInput, raw);
      if (
        input.toolModes &&
        Object.keys(input.toolModes).some((key) => !SENTRY_TOOL_NAMES.includes(key as never))
      )
        throw new ApiError(400, "invalid_request", "Unknown Sentry tool permission.");
      const connection = await getSentryConnection(actor.workspaceId, db);
      if (!connection || connection.status === "disconnected")
        throw new ApiError(409, "conflict", "Connect Sentry first.");
      for (const id of new Set(input.projectIds)) {
        const project = SentryProjectSchema.parse(
          (
            await sentryApi(
              connection,
              `projects/${encodeURIComponent(connection.organizationSlug)}/${id}/`,
              undefined,
              { db },
            )
          ).data,
        );
        if (
          project.id !== id ||
          (project.organization?.slug && project.organization.slug !== connection.organizationSlug)
        )
          throw new ApiError(
            403,
            "forbidden",
            "Project does not belong to this Sentry organization.",
          );
      }
      // Webhook ingress and Task admission lock the same connection row, so no Sentry request may
      // run while it is held. Settings commit first. Until verification completes, the connection
      // stays visibly incomplete and cannot route events; retrying settings retries verification.
      await db.transaction(async (tx: DbLike) => {
        await lockCurrentConnection(tx, actor, connection);
        await tx
          .update(sentryConnections)
          .set({
            selectedProjectIds: [...new Set(input.projectIds)],
            cooldownMinutes: input.cooldownMinutes,
            dailyCap: input.dailyCap,
          })
          .where(eq(sentryConnections.integrationId, connection.integrationId));
        await tx
          .update(integrations)
          .set({
            updatedAt: new Date(),
            ...(input.capabilityModes ? { capabilityModes: input.capabilityModes } : {}),
            ...(input.toolModes ? { toolModes: input.toolModes } : {}),
          })
          .where(eq(integrations.id, connection.integrationId));
      });
      if (!connection.verifiedAt)
        await sentryRequest(
          `sentry-app-installations/${connection.installationId}/`,
          { status: "installed" },
          await sentryAccessToken(connection, { db }),
          undefined,
          "PUT",
        );
      // A disconnect that landed during the request wins over the verification.
      await db.transaction(async (tx: DbLike) => {
        await lockCurrentConnection(tx, actor, connection);
        await tx
          .update(sentryConnections)
          .set({ verifiedAt: new Date() })
          .where(eq(sentryConnections.integrationId, connection.integrationId));
        await tx
          .update(integrations)
          .set({ status: "connected", statusReason: null, updatedAt: new Date() })
          .where(eq(integrations.id, connection.integrationId));
      });
      return get(actor);
    },
    // Checks the fix template's repository before the draft exists. Activation repeats the check
    // and also requires the coding account.
    async validateFixSetup(actor: Actor, setup: SentryFixSetupDto) {
      await validateWorkflowStepRepository({
        userWorkosId: actor.userId,
        engine: setup.engine,
        repository: { fullName: setup.repository, baseBranch: setup.baseBranch },
      });
      return setup;
    },
    async disconnect(actor: Actor) {
      requireAdmin(actor);
      const connection = await getSentryConnection(actor.workspaceId, db);
      if (connection) await disconnectSentry(connection.installationId, db);
      return get(actor);
    },
    async webhook(request: Request) {
      if (!sentryConfigured()) return new Response("Sentry is not configured", { status: 503 });
      const raw = await request.text();
      if (!verifySentrySignature(raw, request.headers.get("sentry-hook-signature")))
        return new Response("Invalid signature", { status: 401 });
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      const parsed = SentryEnvelopeSchema.safeParse(decoded);
      if (!parsed.success) return new Response("Invalid Sentry envelope", { status: 400 });
      const resource = request.headers.get("sentry-hook-resource");
      const timestamp = Number(request.headers.get("sentry-hook-timestamp"));
      if (
        !resource ||
        !["issue", "event_alert", "installation"].includes(resource) ||
        !Number.isFinite(timestamp) ||
        timestamp <= 0 ||
        Number.isNaN(new Date(timestamp * 1000).getTime())
      )
        return new Response("Invalid Sentry headers", { status: 400 });
      const payload = parsed.data;
      // Never retain installation grant codes in an unencrypted receipt.
      if (
        resource === "installation" &&
        payload.data.installation &&
        typeof payload.data.installation === "object"
      )
        delete (payload.data.installation as Record<string, unknown>).code;
      const id = `sentry_${createHash("sha256").update(`${payload.installation.uuid}:${resource}:${raw}`).digest("hex")}`;
      await db.transaction(async (tx: DbLike) => {
        await tx
          .insert(sentryWebhookReceipts)
          .values({
            id,
            installationId: payload.installation.uuid,
            resource,
            payload,
            eventAt: new Date(timestamp * 1000),
          })
          .onConflictDoNothing();
        if (resource === "installation" && payload.action === "deleted")
          await disconnectSentry(payload.installation.uuid, tx);
      });
      return new Response(null, { status: 202 });
    },
    async alertAction(request: Request) {
      const raw = await request.text();
      const signature =
        request.headers.get("sentry-hook-signature") ?? request.headers.get("sentry-app-signature");
      if (!verifySentrySignature(raw, signature))
        return new Response("Invalid signature", { status: 401 });
      const failure = (message: string) => Response.json({ message }, { status: 400 });
      const optionsRequest = request.method === "GET";
      let decoded: unknown;
      try {
        decoded = optionsRequest
          ? Object.fromEntries(new URL(request.url).searchParams)
          : JSON.parse(raw);
      } catch {
        return failure("Invalid Sentry alert configuration");
      }
      const parsed = z
        .object({
          installationId: z.uuid().toLowerCase(),
          fields: z.array(z.object({ name: z.string(), value: z.unknown() })).optional(),
          projectSlug: z.string().optional(),
          projectId: z.union([z.string(), z.number()]).optional(),
          query: z.string().max(256).optional(),
        })
        .passthrough()
        .safeParse(decoded);
      if (!parsed.success) return failure("Invalid Sentry alert configuration");
      const body = parsed.data;
      const connection = await findSentryInstallation(body.installationId, db);
      if (!connection?.verifiedAt || connection.status !== "connected")
        return failure("Disconnected account");
      let projectId = body.projectId ? String(body.projectId) : undefined;
      if (body.projectSlug) {
        const result = await sentryApi(
          connection,
          `projects/${encodeURIComponent(connection.organizationSlug)}/${encodeURIComponent(body.projectSlug)}/`,
          undefined,
          { db },
        );
        projectId = SentryProjectSchema.parse(result.data).id;
        if (!connection.selectedProjectIds.includes(projectId))
          return failure("Project access is not enabled");
      }
      const routes = await listCompanyWorkflowEventTriggerRoutes(
        {
          provider: "sentry",
          integrations: [
            {
              id: connection.integrationId,
              workspaceId: connection.workspaceId,
              userWorkosId: connection.userWorkosId,
              status: "connected",
            },
          ],
        },
        db,
      );
      const shared = sentryRows<{ id: string }>(
        await db.execute(
          sql`SELECT id FROM goat.workflows WHERE workspace_id = ${connection.workspaceId} AND scope = 'company' AND status = 'active' AND archived_at IS NULL`,
        ),
      );
      const members = new Set(
        sentryRows<{ id: string }>(
          await db.execute(
            sql`SELECT actor.workos_user_id AS id FROM goat.users actor JOIN goat.workspace_members member ON member.user_workos_id = actor.workos_user_id WHERE member.workspace_id = ${connection.workspaceId} AND actor.onboarded_at IS NOT NULL`,
          ),
        ).map((member) => member.id),
      );
      const eligible = routes.filter(
        (route) =>
          route.event === "issue_alert.triggered" &&
          members.has(route.userWorkosId) &&
          !!route.activatedAt &&
          shared.some((workflow) => workflow.id === route.workflowId) &&
          connection.selectedProjectIds.includes(route.filters.project!.id) &&
          (!projectId || route.filters.project!.id === projectId),
      );
      if (optionsRequest)
        return Response.json(
          eligible
            .filter(
              (route) =>
                !body.query || route.workflowName.toLowerCase().includes(body.query.toLowerCase()),
            )
            .map((route) => ({
              label: route.workflowName,
              value: JSON.stringify({ workflowId: route.workflowId, triggerId: route.triggerId }),
            })),
        );
      const fields = Object.fromEntries(
        (body.fields ?? []).map((field) => [field.name, field.value]),
      );
      let destination: { workflowId?: string; triggerId?: string };
      try {
        destination = JSON.parse(String(fields.destination));
      } catch {
        return failure("Choose an eligible opencompany workflow");
      }
      if (
        !destination ||
        typeof destination !== "object" ||
        !eligible.some(
          (route) =>
            route.workflowId === destination.workflowId &&
            route.triggerId === destination.triggerId,
        )
      )
        return failure("Workflow destination is no longer eligible");
      return Response.json({});
    },
  };
}
export type SentryService = ReturnType<typeof createSentryService>;
