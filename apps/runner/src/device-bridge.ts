import { createHash, randomUUID } from "node:crypto";
import {
  BRIDGE_SHELL_TIMEOUT_MS,
  type BridgeDecision,
  type BridgeGrantScope,
  type BridgeToolName,
  type BridgeVerdict,
  type DaemonToRunnerMessage,
  type RunnerToDaemonMessage,
  isBridgeToolName,
} from "@opencompany/bridge/protocol";
import {
  agentSessions,
  agentToolApprovals,
  deviceActions,
  workspaceDevices,
} from "@opencompany/db/schema";
import { createLogger } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";

const logger = createLogger({ service: "opencompany-runner", runtime: "device-bridge" });

// How long the gate waits for the daemon's permission verdict. Short: the daemon answers
// from its in-memory rulebook, so a slow answer means a dead/wedged connection and the
// call should proceed to execute (which fails with its own visible timeout).
const CHECK_TIMEOUT_MS = 10_000;
// Non-shell tools are quick file operations; shell gets its daemon-side timeout plus
// headroom so the daemon's own cap fires first with a proper exit code.
const EXECUTE_TIMEOUT_MS = 60_000;
const SHELL_EXECUTE_TIMEOUT_MS = BRIDGE_SHELL_TIMEOUT_MS + 30_000;
const LAST_SEEN_THROTTLE_MS = 60_000;

export { isBridgeToolName };

// Minimal socket surface so tests can drive the registry with fakes and the transport
// (ws under Fastify) stays swappable.
export type DeviceSocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type PendingRequest = {
  resolve: (message: DaemonToRunnerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type DeviceConnection = {
  deviceId: string;
  workspaceId: string;
  userId: string;
  socket: DeviceSocket;
  pending: Map<string, PendingRequest>;
  lastSeenWriteAt: number;
};

const connections = new Map<string, DeviceConnection>();

export class DeviceBridgeError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "DeviceBridgeError";
    this.code = code;
  }
}

export function hashDeviceSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

// Authenticate a daemon's connection headers against workspace_devices. Returns the
// device row identifiers or null (the route closes the socket on null).
export async function authenticateDeviceConnection(input: {
  authorizationHeader: string | undefined;
  deviceIdHeader: string | undefined;
}): Promise<{ deviceId: string; workspaceId: string; userId: string } | null> {
  const secret = input.authorizationHeader?.replace(/^Bearer\s+/i, "")?.trim();
  const deviceId = input.deviceIdHeader?.trim();
  if (!secret || !deviceId) return null;
  const [device] = await getDb()
    .select({
      id: workspaceDevices.id,
      workspaceId: workspaceDevices.workspaceId,
      userId: workspaceDevices.userId,
      secretHash: workspaceDevices.secretHash,
      status: workspaceDevices.status,
    })
    .from(workspaceDevices)
    .where(eq(workspaceDevices.id, deviceId))
    .limit(1);
  if (!device || device.status !== "active") return null;
  if (device.secretHash !== hashDeviceSecret(secret)) return null;
  return { deviceId: device.id, workspaceId: device.workspaceId, userId: device.userId };
}

// Register an authenticated daemon socket. Returns the handlers the transport wires up.
// A device reconnecting replaces its previous (now stale) connection.
export function registerDeviceConnection(input: {
  deviceId: string;
  workspaceId: string;
  userId: string;
  socket: DeviceSocket;
}) {
  const existing = connections.get(input.deviceId);
  if (existing) {
    failAllPending(existing, new DeviceBridgeError("Device reconnected.", "device_reconnected"));
    try {
      existing.socket.close(4000, "Replaced by a new connection from this device.");
    } catch {
      // The old socket may already be gone.
    }
  }
  const connection: DeviceConnection = {
    deviceId: input.deviceId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    socket: input.socket,
    pending: new Map(),
    lastSeenWriteAt: 0,
  };
  connections.set(input.deviceId, connection);
  void touchDeviceLastSeen(connection);
  logger.info("Device connected", {
    event: "opencompany.device_bridge_connected",
    device_id: input.deviceId,
    workspace_id: input.workspaceId,
  });

  return {
    onMessage(data: string) {
      void touchDeviceLastSeen(connection);
      let message: DaemonToRunnerMessage;
      try {
        message = JSON.parse(data) as DaemonToRunnerMessage;
      } catch {
        logger.warn("Unparseable device message", {
          event: "opencompany.device_bridge_bad_message",
          device_id: connection.deviceId,
        });
        return;
      }
      const pending = connection.pending.get(message.id);
      if (!pending) return;
      connection.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    },
    onClose() {
      // Only deregister if this connection is still the current one (a reconnect may
      // have already replaced it).
      if (connections.get(input.deviceId) === connection) {
        connections.delete(input.deviceId);
      }
      failAllPending(
        connection,
        new DeviceBridgeError("The device disconnected.", "device_disconnected"),
      );
      logger.info("Device disconnected", {
        event: "opencompany.device_bridge_disconnected",
        device_id: input.deviceId,
      });
    },
  };
}

// Immediately drop a device's live connection (called when the user revokes the device
// in settings — the DB status flip alone would only block the NEXT connect).
export function disconnectDevice(deviceId: string) {
  const connection = connections.get(deviceId);
  if (!connection) return false;
  connections.delete(deviceId);
  failAllPending(connection, new DeviceBridgeError("The device was revoked.", "device_revoked"));
  try {
    connection.socket.close(4403, "Device revoked.");
  } catch {
    // The socket may already be gone.
  }
  return true;
}

function failAllPending(connection: DeviceConnection, error: Error) {
  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  connection.pending.clear();
}

async function touchDeviceLastSeen(connection: DeviceConnection) {
  const now = Date.now();
  if (now - connection.lastSeenWriteAt < LAST_SEEN_THROTTLE_MS) return;
  connection.lastSeenWriteAt = now;
  try {
    await getDb()
      .update(workspaceDevices)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(workspaceDevices.id, connection.deviceId));
  } catch (error) {
    logger.warn("Failed to update device last_seen_at", {
      event: "opencompany.device_bridge_last_seen_failed",
      device_id: connection.deviceId,
      error,
    });
  }
}

function sendRequest(
  connection: DeviceConnection,
  message: RunnerToDaemonMessage,
  timeoutMs: number,
): Promise<DaemonToRunnerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(message.id);
      reject(
        new DeviceBridgeError(
          "The device did not answer in time. It may be asleep or offline.",
          "device_timeout",
        ),
      );
    }, timeoutMs);
    connection.pending.set(message.id, { resolve, reject, timer });
    try {
      connection.socket.send(JSON.stringify(message));
    } catch (error) {
      connection.pending.delete(message.id);
      clearTimeout(timer);
      reject(
        new DeviceBridgeError(
          error instanceof Error ? error.message : "Failed to reach the device.",
          "device_send_failed",
        ),
      );
    }
  });
}

// The session's target device: the session owner's active paired device in this
// workspace. v1 is one device per user; with several paired, prefer a connected one.
export async function resolveSessionDevice(sessionId: string): Promise<{
  deviceId: string;
  workspaceId: string;
  name: string;
  connection: DeviceConnection | null;
} | null> {
  const [session] = await getDb()
    .select({ workspaceId: agentSessions.workspaceId, userId: agentSessions.userId })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!session?.userId) return null;
  const devices = await getDb()
    .select({
      id: workspaceDevices.id,
      workspaceId: workspaceDevices.workspaceId,
      name: workspaceDevices.name,
    })
    .from(workspaceDevices)
    .where(
      and(
        eq(workspaceDevices.workspaceId, session.workspaceId),
        eq(workspaceDevices.userId, session.userId),
        eq(workspaceDevices.status, "active"),
      ),
    );
  if (devices.length === 0) return null;
  const online = devices.find((device) => connections.has(device.id)) ?? devices[0];
  if (!online) return null;
  return {
    deviceId: online.id,
    workspaceId: online.workspaceId,
    name: online.name,
    connection: connections.get(online.id) ?? null,
  };
}

export type DeviceGateResult =
  | { kind: "verdict"; verdict: BridgeVerdict }
  | { kind: "unreachable" };

// The gate's pre-flight question to the daemon: would this call be allowed? Used by the
// stream gate to decide allow / suspend-for-approval / deny BEFORE the tool starts.
// "unreachable" (no device, offline, or check timeout) maps to allow at the gate — the
// execute path then fails with a clean, visible error the model can relay.
export async function checkDevicePermission(input: {
  sessionId: string;
  tool: BridgeToolName;
  args: unknown;
}): Promise<DeviceGateResult> {
  // Nothing in the gate path may throw: a transient DB or socket failure here would
  // kill the whole turn. Unreachable lets the call proceed to execute(), which fails
  // with its own clean, visible error.
  try {
    const device = await resolveSessionDevice(input.sessionId);
    if (!device?.connection) return { kind: "unreachable" };
    const response = await sendRequest(
      device.connection,
      {
        kind: "check",
        id: randomUUID(),
        sessionId: input.sessionId,
        tool: input.tool,
        args: input.args,
      },
      CHECK_TIMEOUT_MS,
    );
    if (response.kind !== "verdict") return { kind: "unreachable" };
    // A rule-deny at the gate is final — execute() never runs, so this is the only
    // place it can reach the audit log. Allowed calls are recorded at execute time.
    if (response.verdict === "deny") {
      await recordDeviceAction({
        workspaceId: device.workspaceId,
        deviceId: device.deviceId,
        sessionId: input.sessionId,
        tool: input.tool,
        summary: response.summary,
        decision: "denied_by_rule",
      });
    }
    return { kind: "verdict", verdict: response.verdict };
  } catch {
    return { kind: "unreachable" };
  }
}

// Execute a local tool on the session owner's device. Reads the call's approval row so a
// just-approved (resumed) call carries the user's grant scope down to the daemon — the
// daemon records the grant (once/session/always) and runs. Every device-side decision is
// mirrored into the device_actions audit log.
export async function executeDeviceTool(input: {
  sessionId: string;
  toolCallId: string;
  name: BridgeToolName;
  args: unknown;
}): Promise<unknown> {
  const device = await resolveSessionDevice(input.sessionId);
  if (!device) {
    throw new DeviceBridgeError(
      "No paired device found for this user. Pair one with `oc-bridge pair`.",
      "device_not_paired",
    );
  }
  if (!device.connection) {
    throw new DeviceBridgeError(
      `The device "${device.name}" is offline. Ask the user to run \`oc-bridge start\` on their machine.`,
      "device_offline",
    );
  }

  const grant = await loadApprovedGrant(input.sessionId, input.toolCallId);
  const response = await sendRequest(
    device.connection,
    {
      kind: "execute",
      id: randomUUID(),
      sessionId: input.sessionId,
      tool: input.name,
      args: input.args,
      ...(grant ? { grant } : {}),
    },
    input.name === "local_shell" ? SHELL_EXECUTE_TIMEOUT_MS : EXECUTE_TIMEOUT_MS,
  );
  if (response.kind !== "result") {
    throw new DeviceBridgeError("The device sent an unexpected reply.", "device_bad_reply");
  }

  await recordDeviceAction({
    workspaceId: device.workspaceId,
    deviceId: device.deviceId,
    sessionId: input.sessionId,
    tool: input.name,
    summary: response.summary,
    decision: response.ok ? response.decision : (response.decision ?? "denied_by_rule"),
  });

  if (!response.ok) {
    throw new DeviceBridgeError(response.error.message, response.error.code);
  }
  return response.output;
}

async function loadApprovedGrant(
  sessionId: string,
  toolCallId: string,
): Promise<{ scope: BridgeGrantScope } | null> {
  const [approval] = await getDb()
    .select({
      status: agentToolApprovals.status,
      decisionScope: agentToolApprovals.decisionScope,
    })
    .from(agentToolApprovals)
    .where(
      and(
        eq(agentToolApprovals.sessionId, sessionId),
        eq(agentToolApprovals.toolCallId, toolCallId),
      ),
    )
    .limit(1);
  if (!approval || approval.status !== "approved") return null;
  return { scope: approval.decisionScope ?? "once" };
}

async function recordDeviceAction(input: {
  workspaceId: string;
  deviceId: string;
  sessionId: string;
  tool: string;
  summary: string;
  decision: BridgeDecision;
}) {
  try {
    await getDb()
      .insert(deviceActions)
      .values({
        id: `dact_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        workspaceId: input.workspaceId,
        deviceId: input.deviceId,
        sessionId: input.sessionId,
        tool: input.tool,
        // Cap the summary: it is a human-readable audit line, not a payload store.
        summary: input.summary.slice(0, 500),
        decision: input.decision,
      });
  } catch (error) {
    logger.warn("Failed to record device action", {
      event: "opencompany.device_bridge_audit_failed",
      device_id: input.deviceId,
      error,
    });
  }
}

// Connected-device summary for the agent's system context.
export async function loadConnectedDevices(input: {
  workspaceId: string;
  userId: string;
}): Promise<{ name: string; online: boolean }[]> {
  const devices = await getDb()
    .select({ id: workspaceDevices.id, name: workspaceDevices.name })
    .from(workspaceDevices)
    .where(
      and(
        eq(workspaceDevices.workspaceId, input.workspaceId),
        eq(workspaceDevices.userId, input.userId),
        eq(workspaceDevices.status, "active"),
      ),
    );
  return devices.map((device) => ({ name: device.name, online: connections.has(device.id) }));
}
