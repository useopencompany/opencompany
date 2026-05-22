export const DEFAULT_AGENT_NAMES = [
  "ada",
  "atlas",
  "cleo",
  "cosmo",
  "echo",
  "finn",
  "hermes",
  "ivy",
  "juno",
  "leo",
  "luna",
  "milo",
  "nova",
  "orion",
  "piper",
  "sage",
  "sol",
  "tess",
  "vega",
  "zara",
] as const;

export function randomAgentName(random = Math.random) {
  const index = Math.floor(random() * DEFAULT_AGENT_NAMES.length);
  return DEFAULT_AGENT_NAMES[Math.min(index, DEFAULT_AGENT_NAMES.length - 1)] ?? "leo";
}
