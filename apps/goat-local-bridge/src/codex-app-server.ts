export const CODEX_APP_SERVER_ACCESS_MODE = "dangerously-bypass-approvals-and-sandbox";
export const CODEX_APP_SERVER_ENV_INHERIT = "all";

export function buildCodexAppServerArgs() {
  return [
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `shell_environment_policy.inherit=${CODEX_APP_SERVER_ENV_INHERIT}`,
    "app-server",
    "--listen",
    "stdio://",
  ];
}
