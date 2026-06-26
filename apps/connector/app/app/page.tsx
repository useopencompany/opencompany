import { buttonVariants } from "@opencompany/ui/components/button";
import { Lock, Settings } from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import { currentConnectorOrganization, displayConnectorUserName } from "@/lib/auth";
import { CONNECTOR_LINEAR_MCP_ENDPOINT_URL, loadConnectorLinearMcpSettings } from "@/lib/mcp/data";
import { describeConnectorLinearStatus } from "@/lib/mcp/status";
import {
  CONNECTOR_LINEAR_PERMISSION_LABELS,
  CONNECTOR_LINEAR_PERMISSION_SCOPES,
} from "@/lib/permissions";
import { loadConnectorLinearPermissions } from "@/lib/setup/data";
import { McpCanvas } from "./mcp-canvas";

export default async function ConnectorAppPage() {
  const { user, organization } = await currentConnectorOrganization({ requireCompleted: true });
  const [linear, permissions] = await Promise.all([
    loadConnectorLinearMcpSettings(organization.id),
    loadConnectorLinearPermissions(organization.id),
  ]);
  const linearStatus = describeConnectorLinearStatus(linear);
  const enabledPermissionLabels = CONNECTOR_LINEAR_PERMISSION_SCOPES.filter(
    (scope) => permissions[scope],
  ).map((scope) => CONNECTOR_LINEAR_PERMISSION_LABELS[scope]);

  return (
    <main className="min-h-screen bg-background font-mono">
      <section className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-12 sm:px-8">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Connector</p>
            <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground">
              {organization.name}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Signed in as {displayConnectorUserName(user)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/setup"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "font-mono")}
            >
              <Settings size={14} />
              Setup
            </a>
            <a
              href="/auth/sign-out"
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "font-mono")}
            >
              Sign out
            </a>
          </div>
        </header>

        <section className="py-8">
          <McpCanvas
            linear={{
              status: linearStatus.label,
              tone: linearStatus.tone,
              detail: linearStatus.detail,
              footer: CONNECTOR_LINEAR_MCP_ENDPOINT_URL,
            }}
            connector={{
              status: "Ready",
              tone: "success",
              detail: "Organization setup is complete. Connector policy is stored locally.",
              footer: `/${organization.slug}`,
            }}
            team={{
              status: "Preview",
              tone: "muted",
              detail: "Visual preview only. The downstream MCP endpoint is not implemented in v1.",
              footer: "Coming next",
            }}
          />
        </section>

        <section className="grid gap-6 border-t border-border py-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Linear permissions
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {CONNECTOR_LINEAR_PERMISSION_SCOPES.map((scope) => {
                const enabled = permissions[scope];
                return (
                  <div key={scope} className="rounded-lg border border-border bg-background p-4">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={cn(
                          "flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground",
                          enabled && "border-foreground bg-foreground text-background",
                        )}
                      >
                        <Lock size={13} />
                      </span>
                      <p className="text-sm font-medium text-foreground">
                        {CONNECTOR_LINEAR_PERMISSION_LABELS[scope]}
                      </p>
                    </div>
                    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                      {enabled ? "Enabled for Connector policy." : "Disabled for Connector policy."}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          <aside className="rounded-lg border border-border p-5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Setup status
            </p>
            <dl className="mt-4 space-y-4 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Completed</dt>
                <dd className="mt-1 font-medium text-foreground">
                  {organization.setupCompletedAt
                    ? formatConnectorTimestamp(organization.setupCompletedAt)
                    : "Not completed"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Organization slug</dt>
                <dd className="mt-1 font-medium text-foreground">{organization.slug}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Granted policy</dt>
                <dd className="mt-1 font-medium text-foreground">
                  {enabledPermissionLabels.length > 0
                    ? enabledPermissionLabels.join(", ")
                    : "No permissions enabled"}
                </dd>
              </div>
            </dl>
          </aside>
        </section>
      </section>
    </main>
  );
}

function formatConnectorTimestamp(value: Date) {
  return value.toISOString().slice(0, 16).replace("T", " ");
}
