export { type BridgeConfig, bridgeHome, configPath, loadConfig, saveConfig } from "./config";
export {
  createMessageHandler,
  type MessageHandlerOptions,
  type SessionGrants,
  startDaemon,
} from "./daemon";
export { type BridgeExecutor, createExecutor } from "./executor";
export { runPairing } from "./pair";
export {
  deriveGrantRule,
  evaluatePermission,
  expandTilde,
  type PermissionRequest,
  type PermissionResult,
  resolveBridgePath,
} from "./permissions";
export * from "./protocol";
export {
  appendAllowRule,
  type BridgeMode,
  type BridgeSettings,
  defaultSettings,
  loadSettings,
  saveSettings,
  settingsPath,
} from "./settings";
export {
  type BridgeActivityEntry,
  type BridgeStatus,
  type BridgeStatusWriter,
  createStatusWriter,
  readStatus,
  statusPath,
} from "./status";
