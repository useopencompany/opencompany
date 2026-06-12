"use client";

import { Laptop, ShieldX } from "lucide-react";
import { useState, useTransition } from "react";
import {
  confirmDevicePairing,
  type DeviceActionSummary,
  type DeviceSummary,
  revokeDevice,
} from "@/lib/devices/actions";

// Settings → Devices: pair the user's own computer (confirm the code shown by
// `oc-bridge pair`), see paired devices, revoke them, and audit what agents did there.
// Permission rules themselves live ON the device (its local settings file) — this page
// deliberately has no grant editor; the cloud can ask, never grant.
export function DevicesView({
  devices,
  actions,
}: {
  devices: DeviceSummary[];
  actions: DeviceActionSummary[];
}) {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const submitCode = () => {
    if (!code.trim()) return;
    startTransition(async () => {
      const result = await confirmDevicePairing({ code });
      if (result.ok) {
        setMessage({ tone: "success", text: `Paired "${result.deviceName}".` });
        setCode("");
      } else {
        setMessage({ tone: "error", text: result.error });
      }
    });
  };

  const submitRevoke = (deviceId: string) => {
    startTransition(async () => {
      const result = await revokeDevice({ deviceId });
      setMessage(
        result.ok
          ? { tone: "success", text: "Device revoked." }
          : { tone: "error", text: result.error },
      );
    });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      <div>
        <h1 className="text-lg font-semibold text-ink">Devices</h1>
        <p className="mt-1 text-[13px] leading-5 text-ink-muted">
          Connect your own computer so agents can act on it — with your approval. Install the
          bridge, run <code className="rounded bg-surface-muted px-1">oc-bridge pair</code> in your
          terminal, and enter the code it shows here. Permission rules live on your device; agents
          ask in chat before doing anything you haven&apos;t allowed.
        </p>
      </div>

      <section className="rounded-lg border border-border bg-surface-raised/60 p-4">
        <h2 className="text-[13px] font-semibold text-ink">Pair a device</h2>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="ABC-123"
            maxLength={7}
            className="h-8 w-32 rounded-md border border-border bg-surface px-2 font-mono text-[13px] tracking-widest text-ink outline-none focus:border-ink/40"
          />
          <button
            type="button"
            disabled={isPending || code.replace(/[^A-Z0-9]/g, "").length !== 6}
            onClick={submitCode}
            className="inline-flex h-8 items-center rounded-md bg-ink px-3 text-[12px] font-medium text-surface transition-colors hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "Pairing…" : "Pair device"}
          </button>
        </div>
        {message ? (
          <div
            className={`mt-2 text-[12px] ${message.tone === "success" ? "text-success" : "text-danger"}`}
          >
            {message.text}
          </div>
        ) : null}
      </section>

      <section>
        <h2 className="text-[13px] font-semibold text-ink">Your devices</h2>
        {devices.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-ink-muted">No devices paired yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {devices.map((device) => (
              <li
                key={device.id}
                className="flex items-center justify-between rounded-lg border border-border bg-surface-raised/60 px-3 py-2.5"
              >
                <div className="flex items-center gap-2.5">
                  <Laptop size={16} strokeWidth={1.75} className="text-ink-subtle" />
                  <div>
                    <div className="text-[13px] font-medium text-ink">{device.name}</div>
                    <div className="text-[11.5px] text-ink-muted">
                      {device.platform}
                      {" · "}
                      {device.online ? (
                        <span className="text-success">online</span>
                      ) : device.lastSeenAt ? (
                        `last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                      ) : (
                        "never connected"
                      )}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => submitRevoke(device.id)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2.5 text-[11.5px] font-medium text-danger transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ShieldX size={12} strokeWidth={1.9} />
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-[13px] font-semibold text-ink">Recent activity</h2>
        {actions.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-ink-muted">
            Nothing yet — actions agents take on your devices appear here.
          </p>
        ) : (
          <div className="mt-2 overflow-hidden rounded-lg border border-border">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-surface-muted/60 text-[11px] uppercase tracking-wide text-ink-subtle">
                <tr>
                  <th className="px-3 py-1.5 font-medium">When</th>
                  <th className="px-3 py-1.5 font-medium">Device</th>
                  <th className="px-3 py-1.5 font-medium">Action</th>
                  <th className="px-3 py-1.5 font-medium">Decision</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((action) => (
                  <tr key={action.id} className="border-t border-border/70">
                    <td className="whitespace-nowrap px-3 py-1.5 text-ink-muted">
                      {new Date(action.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-ink/80">{action.deviceName}</td>
                    <td className="max-w-[260px] px-3 py-1.5">
                      <span className="text-ink/80">{action.tool.replace(/^local_/, "")}</span>
                      <span className="ml-1.5 block truncate font-mono text-[11px] text-ink-muted">
                        {action.summary}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <span
                        className={
                          action.decision.startsWith("denied") ? "text-danger" : "text-success"
                        }
                      >
                        {action.decision.replaceAll("_", " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
