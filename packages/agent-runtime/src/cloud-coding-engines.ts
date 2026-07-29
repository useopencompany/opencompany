export type CloudCodingEngineDescriptor = {
  label: string;
  workDirectory: string;
};

export const CLOUD_CODING_ENGINE_CONFIG = {
  codex: {
    label: "Codex",
    workDirectory: "/home/user/opencompany-goat/codex-chat",
  },
  claude_code: {
    label: "Claude Code",
    workDirectory: "/home/user/opencompany-goat/claude-chat",
  },
} as const satisfies Record<string, CloudCodingEngineDescriptor>;

export type CloudCodingEngine = keyof typeof CLOUD_CODING_ENGINE_CONFIG;

export function isCloudCodingEngine(value: unknown): value is CloudCodingEngine {
  return typeof value === "string" && Object.hasOwn(CLOUD_CODING_ENGINE_CONFIG, value);
}
