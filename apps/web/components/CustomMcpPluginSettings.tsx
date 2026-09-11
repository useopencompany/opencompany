"use client";

import type {
  CustomMcpDefinitionBody,
  CustomMcpProbeDto,
  CustomMcpStatusDto,
  PluginInstallationDto,
} from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import { Input } from "@opencompany/ui/components/input";
import { Label } from "@opencompany/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@opencompany/ui/components/select";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { SettingsContent } from "@/components/SettingsChrome";
import {
  archiveHeadlessPlugin,
  connectCustomMcp,
  createCustomMcp,
  disableHeadlessPlugin,
  disconnectCustomMcp,
  enableHeadlessPlugin,
  previewCustomMcp,
  refreshCustomMcp,
  setCustomMcpToolMode,
} from "@/lib/headless-knowledge-commands";

type CustomMcpToolView = { name: string; description?: string };

type Header = { id: string; name: string; value: string };
type Authentication = "none" | "bearer" | "headers";

export function AddCustomMcpPlugin({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  return (
    <SettingsContent
      title="Add custom MCP"
      description="Connect tools from a hosted MCP server."
      backLink={{ href: "/settings/plugins", label: "Plugins" }}
    >
      {canEdit ? (
        <CustomMcpForm
          onCreated={(plugin) => {
            router.push(`/settings/plugins/${plugin.name}`);
            router.refresh();
          }}
        />
      ) : (
        <p className="text-sm text-ink-muted">
          You need plugin write permission to add this plugin. Once installed, connect your own
          account.
        </p>
      )}
    </SettingsContent>
  );
}

function CustomMcpForm({
  definition,
  onCreated,
  onConnected,
}: {
  definition?: { name: string; label: string; url: string };
  onCreated?: (plugin: PluginInstallationDto) => void;
  onConnected?: (status: CustomMcpStatusDto) => void;
}) {
  const [label, setLabel] = useState(definition?.label ?? "");
  const [url, setUrl] = useState(definition?.url ?? "");
  const [authentication, setAuthentication] = useState<Authentication>("none");
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState<Header[]>([]);
  const [preview, setPreview] = useState<CustomMcpProbeDto | null>(null);
  const [pending, setPending] = useState<"test" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const invalidate = () => {
    setPreview(null);
    setError(null);
    idempotencyKey.current = null;
  };
  const credentials = (): CustomMcpDefinitionBody => {
    const entries =
      authentication === "bearer"
        ? [["Authorization", `Bearer ${token.trim()}`]]
        : authentication === "headers"
          ? headers.map((header) => [header.name.trim(), header.value])
          : [];
    if (authentication === "bearer" && !token.trim()) throw new Error("Enter your bearer token.");
    if (
      authentication === "headers" &&
      (!entries.length || entries.some(([name, value]) => !name || !value))
    )
      throw new Error("Enter a name and value for each authentication header.");
    if (new Set(entries.map(([name]) => name?.toLowerCase())).size !== entries.length)
      throw new Error("Each header name must be unique.");
    return { label: label.trim(), url: url.trim(), headers: Object.fromEntries(entries) };
  };
  const submit = async () => {
    setError(null);
    setPending(definition || preview ? "save" : "test");
    try {
      const input = credentials();
      if (definition) {
        const status = await connectCustomMcp(definition.name, { headers: input.headers });
        setToken("");
        setHeaders([]);
        onConnected?.(status);
      } else if (!preview) {
        setPreview(await previewCustomMcp(input));
      } else {
        idempotencyKey.current ??= `web-custom-mcp:${crypto.randomUUID()}`;
        const result = await createCustomMcp(
          { ...input, fingerprint: preview.fingerprint },
          idempotencyKey.current,
        );
        setToken("");
        setHeaders([]);
        onCreated?.(result.plugin);
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(null);
    }
  };
  return (
    <form
      className="max-w-xl space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) void submit();
      }}
    >
      <fieldset disabled={pending !== null} className="space-y-5">
        {!definition ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="mcp-label">Name</Label>
              <Input
                id="mcp-label"
                required
                maxLength={100}
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value);
                  invalidate();
                }}
                placeholder="My company tools"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-url">Server URL</Label>
              <Input
                id="mcp-url"
                type="url"
                required
                maxLength={2048}
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  invalidate();
                }}
                placeholder="https://tools.example.com/mcp"
              />
              <p className="text-xs text-ink-subtle">
                Use a public HTTPS endpoint that supports Streamable HTTP. Keep credentials in the
                authentication fields below.
              </p>
            </div>
          </>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="mcp-auth">Authentication</Label>
          <Select
            value={authentication}
            onValueChange={(value) => {
              setAuthentication(value as Authentication);
              setToken("");
              setHeaders(
                value === "headers" ? [{ id: crypto.randomUUID(), name: "", value: "" }] : [],
              );
              invalidate();
            }}
          >
            <SelectTrigger id="mcp-auth">
              <SelectValue>
                {
                  { none: "None", bearer: "Bearer token", headers: "Custom headers" }[
                    authentication
                  ]
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="bearer">Bearer token</SelectItem>
              <SelectItem value="headers">Custom headers</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {authentication === "bearer" ? (
          <div className="space-y-2">
            <Label htmlFor="mcp-token">Bearer token</Label>
            <Input
              id="mcp-token"
              type="password"
              autoComplete="off"
              required
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                invalidate();
              }}
            />
          </div>
        ) : null}
        {authentication === "headers" ? (
          <div className="space-y-3">
            {headers.map((header, index) => (
              <div className="flex items-end gap-2" key={header.id}>
                <div className="min-w-0 flex-1 space-y-2">
                  <Label htmlFor={`${header.id}-name`}>Header {index + 1}</Label>
                  <Input
                    id={`${header.id}-name`}
                    required
                    placeholder="X-API-Key"
                    value={header.name}
                    onChange={(event) => {
                      setHeaders(
                        headers.map((entry) =>
                          entry.id === header.id ? { ...entry, name: event.target.value } : entry,
                        ),
                      );
                      invalidate();
                    }}
                  />
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <Label htmlFor={`${header.id}-value`}>Value</Label>
                  <Input
                    id={`${header.id}-value`}
                    type="password"
                    autoComplete="off"
                    required
                    value={header.value}
                    onChange={(event) => {
                      setHeaders(
                        headers.map((entry) =>
                          entry.id === header.id ? { ...entry, value: event.target.value } : entry,
                        ),
                      );
                      invalidate();
                    }}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove header ${index + 1}`}
                  onClick={() => {
                    setHeaders(headers.filter((entry) => entry.id !== header.id));
                    invalidate();
                  }}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={headers.length >= 12}
              onClick={() => {
                setHeaders([...headers, { id: crypto.randomUUID(), name: "", value: "" }]);
                invalidate();
              }}
            >
              <Plus size={14} />
              Add header
            </Button>
          </div>
        ) : null}
        <p className="text-xs leading-5 text-ink-subtle">
          Your credentials and permissions are personal. OAuth sign-in and local servers are not
          supported yet.
        </p>
        {preview ? (
          <div className="rounded-lg border border-border p-4" role="status">
            <p className="text-sm font-medium text-ink">
              Connection tested · {preview.tools.length}{" "}
              {preview.tools.length === 1 ? "tool" : "tools"}
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              Every tool starts on Ask. You can change individual permissions after connecting.
            </p>
            {preview.tools.length ? (
              <ul className="mt-3 max-h-56 space-y-2 overflow-auto">
                {preview.tools.map((tool: CustomMcpToolView) => (
                  <li key={tool.name} className="text-sm">
                    <p className="break-words font-medium text-ink">{tool.name}</p>
                    {tool.description ? (
                      <p className="text-xs text-ink-subtle">{tool.description}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-ink-muted">
                This server currently exposes no tools. You can connect now and refresh its tools
                later.
              </p>
            )}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending !== null}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {pending === "test"
            ? "Testing connection…"
            : pending === "save"
              ? "Connecting…"
              : definition
                ? "Test and connect"
                : preview
                  ? "Add plugin and connect"
                  : "Test connection"}
        </Button>
      </fieldset>
    </form>
  );
}

export function CustomMcpPluginDetail({
  plugin,
  initialStatus,
  canEdit,
}: {
  plugin: PluginInstallationDto;
  initialStatus: CustomMcpStatusDto;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(false);
    }
  };
  const account = status.account;
  return (
    <SettingsContent
      title={status.label}
      description="Custom MCP server"
      backLink={{ href: "/settings/plugins", label: "Plugins" }}
    >
      <div className="max-w-2xl space-y-7">
        <div className="space-y-2">
          <p className="break-all text-sm text-ink-muted">{status.url}</p>
          <p className="text-xs text-ink-subtle">
            Installed for you. Your account and permissions are personal.
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        {!status.enabled ? (
          <p role="status" className="text-sm text-ink-muted">
            This plugin is disabled. Enable it to connect or use its tools.
          </p>
        ) : null}
        <section className="space-y-4" aria-label="Your connection">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-ink">Your connection</h2>
            <span className="text-xs text-ink-muted">
              {account?.error
                ? "Needs attention"
                : account?.connected
                  ? "Connected"
                  : "Not connected"}
            </span>
          </div>
          {account?.error ? (
            <p role="alert" className="text-sm text-red-600">
              {account.error}
            </p>
          ) : null}
          {status.enabled && (!account || editingCredentials) ? (
            <>
              <CustomMcpForm
                definition={{ name: plugin.name, label: status.label, url: status.url }}
                onConnected={(next) => {
                  setStatus(next);
                  setEditingCredentials(false);
                }}
              />
              {account ? (
                <Button variant="ghost" size="sm" onClick={() => setEditingCredentials(false)}>
                  Cancel
                </Button>
              ) : null}
            </>
          ) : null}
          {account ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pending || !status.enabled || editingCredentials}
                onClick={() => void run(async () => setStatus(await refreshCustomMcp(plugin.name)))}
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}Refresh tools
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pending || !status.enabled || editingCredentials}
                onClick={() => setEditingCredentials(true)}
              >
                Update credentials
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending || editingCredentials}
                onClick={() =>
                  void run(async () => setStatus(await disconnectCustomMcp(plugin.name)))
                }
              >
                Disconnect my account
              </Button>
            </div>
          ) : null}
        </section>
        {account ? (
          <section className="space-y-3" aria-label="Tool permissions">
            <h2 className="text-sm font-semibold text-ink">
              Tool permissions · {account.tools.length}
            </h2>
            <p className="text-xs text-ink-subtle">
              Ask requires your approval for each call. On lets the assistant run a tool without
              asking. Off hides it from the assistant. New or changed tools return to Ask.
            </p>
            {account.tools.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No tools are available yet. Refresh after adding tools to your server.
              </p>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {account.tools.map((tool: CustomMcpToolView) => (
                  <div key={tool.name} className="flex items-start justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium text-ink">{tool.name}</p>
                      {tool.description ? (
                        <p className="mt-1 text-xs text-ink-subtle">{tool.description}</p>
                      ) : null}
                    </div>
                    <Select
                      value={account.toolModes[tool.name] ?? "ask"}
                      disabled={
                        pending || !status.enabled || !account.connected || editingCredentials
                      }
                      onValueChange={(mode) =>
                        void run(async () =>
                          setStatus(
                            await setCustomMcpToolMode(plugin.name, {
                              tool: tool.name,
                              mode: mode as "on" | "ask" | "off",
                              revision: account.revision,
                            }),
                          ),
                        )
                      }
                    >
                      <SelectTrigger
                        className="w-24 shrink-0"
                        aria-label={`Permission for ${tool.name}`}
                      >
                        <SelectValue>
                          {
                            { ask: "Ask", on: "On", off: "Off" }[
                              (account.toolModes[tool.name] ?? "ask") as "ask" | "on" | "off"
                            ]
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ask">Ask</SelectItem>
                        <SelectItem value="on">On</SelectItem>
                        <SelectItem value="off">Off</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-ink-subtle">
              Last checked {new Date(account.checkedAt).toLocaleString()}
            </p>
          </section>
        ) : null}
        {canEdit ? (
          <section
            className="space-y-3 border-t border-border pt-5"
            aria-label="Plugin installation"
          >
            <h2 className="text-sm font-semibold text-ink">Plugin installation</h2>
            <p className="text-xs text-ink-subtle">
              Disabling or removing this installation affects only your plugin use. To use a
              different endpoint, add a new custom plugin.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await (status.enabled ? disableHeadlessPlugin : enableHeadlessPlugin)(
                      plugin.name,
                    );
                    setStatus({ ...status, enabled: !status.enabled });
                    router.refresh();
                  })
                }
              >
                {status.enabled ? "Disable plugin" : "Enable plugin"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => setConfirmRemove(true)}
              >
                Remove plugin
              </Button>
            </div>
            {confirmRemove ? (
              <div className="space-y-3 rounded-lg border border-border p-4">
                <p className="text-sm text-ink-muted">
                  Remove this plugin for everyone? Its tools will stop being available. All personal
                  connections and saved credentials for this custom plugin will also be removed.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      void run(async () => {
                        await archiveHeadlessPlugin(plugin.name);
                        router.push("/settings/plugins");
                        router.refresh();
                      })
                    }
                  >
                    Remove for everyone
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => setConfirmRemove(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </SettingsContent>
  );
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not update this connection. Try again.";
}
