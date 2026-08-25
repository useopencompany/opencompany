import { Template } from "e2b";
import {
  CLAUDE_CODE_ACP_ADAPTER_PACKAGE,
  CLAUDE_CODE_ACP_ADAPTER_VERSION,
  CLAUDE_CODE_CLI_PACKAGE,
  CLAUDE_CODE_CLI_VERSION,
} from "../../src/claude-code-version";
import {
  CODEX_ACP_ADAPTER_PACKAGE,
  CODEX_ACP_ADAPTER_VERSION,
  CODEX_CLI_PACKAGE,
  CODEX_CLI_VERSION,
} from "../../src/codex-version";
import {
  INFISICAL_CLI_LINUX_AMD64_SHA256,
  INFISICAL_CLI_VERSION,
} from "../../src/infisical-version";

export {
  CLAUDE_CODE_ACP_ADAPTER_PACKAGE,
  CLAUDE_CODE_ACP_ADAPTER_VERSION,
  CLAUDE_CODE_CLI_PACKAGE,
  CLAUDE_CODE_CLI_VERSION,
} from "../../src/claude-code-version";
export {
  CODEX_ACP_ADAPTER_PACKAGE,
  CODEX_ACP_ADAPTER_VERSION,
  CODEX_CLI_PACKAGE,
  CODEX_CLI_VERSION,
} from "../../src/codex-version";
export {
  INFISICAL_CLI_LINUX_AMD64_SHA256,
  INFISICAL_CLI_VERSION,
} from "../../src/infisical-version";

export const CODEX_TOOLBOX_TEMPLATE_ALIAS = "opencompany-codex-toolbox";
export const CODEX_TOOLBOX_CPU_COUNT = 8;
export const CODEX_TOOLBOX_MEMORY_MB = 8192;
export const PLAYWRIGHT_PACKAGE = "playwright@1.60.0";
export const BUN_VERSION = "1.3.2";

const root = { user: "root" } as const;
const user = { user: "user" } as const;

export const template = Template()
  .fromTemplate("codex")
  .runCmd(
    [
      "infisical_install_dir=$(mktemp -d /tmp/opencompany-infisical.XXXXXX)",
      `curl -fsSL https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/cli_${INFISICAL_CLI_VERSION}_linux_amd64.tar.gz -o "$infisical_install_dir/infisical.tar.gz"`,
      `printf '%s  %s\\n' '${INFISICAL_CLI_LINUX_AMD64_SHA256}' "$infisical_install_dir/infisical.tar.gz" | sha256sum -c -`,
      'tar -xzf "$infisical_install_dir/infisical.tar.gz" -C "$infisical_install_dir" infisical',
      'install -m 0755 "$infisical_install_dir/infisical" /usr/local/bin/infisical',
      'rm -rf "$infisical_install_dir"',
      "command -v infisical",
      `test "$(infisical --version)" = "infisical version ${INFISICAL_CLI_VERSION}"`,
    ].join(" && "),
    root,
  )
  .runCmd(
    [
      "export DEBIAN_FRONTEND=noninteractive",
      "apt-get update",
      [
        "apt-get install -y --no-install-recommends",
        "ca-certificates",
        "curl",
        "gnupg",
        "git",
        "jq",
        "iproute2",
        "ripgrep",
        "fd-find",
        "tmux",
        "unzip",
      ].join(" "),
      "ln -sf /usr/bin/fdfind /usr/local/bin/fd",
      "rm -rf /var/lib/apt/lists/*",
    ].join(" && "),
    root,
  )
  .runCmd(
    [
      "mkdir -p -m 755 /etc/apt/keyrings",
      [
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg",
        "| tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null",
      ].join(" "),
      "chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg",
      [
        'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main"',
        "| tee /etc/apt/sources.list.d/github-cli.list >/dev/null",
      ].join(" "),
      "export DEBIAN_FRONTEND=noninteractive",
      "apt-get update",
      "apt-get install -y --no-install-recommends gh",
      "rm -rf /var/lib/apt/lists/*",
    ].join(" && "),
    root,
  )
  .runCmd(
    [
      "curl -fsSL https://get.docker.com | sh",
      "usermod -aG docker user",
      "command -v docker",
      "docker --version",
      "docker compose version",
      "docker run --rm hello-world",
    ].join(" && "),
    root,
  )
  .runCmd(
    [
      "if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 22 ? 0 : 1)'; then",
      "  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -;",
      "  export DEBIAN_FRONTEND=noninteractive;",
      "  apt-get update;",
      "  apt-get install -y --no-install-recommends nodejs;",
      "  ln -sf /usr/bin/node /usr/local/bin/node;",
      "  ln -sf /usr/bin/npm /usr/local/bin/npm;",
      "  ln -sf /usr/bin/npx /usr/local/bin/npx;",
      "  rm -rf /var/lib/apt/lists/*;",
      "fi",
      "node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 22 ? 0 : 1)'",
    ].join("\n"),
    root,
  )
  .runCmd(
    [
      `curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}"`,
      `test "$(bun --version)" = "${BUN_VERSION}"`,
      `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g --prefix /usr/local ${CODEX_CLI_PACKAGE} ${CODEX_ACP_ADAPTER_PACKAGE} ${CLAUDE_CODE_CLI_PACKAGE} ${CLAUDE_CODE_ACP_ADAPTER_PACKAGE} ${PLAYWRIGHT_PACKAGE}`,
      "command -v rg",
      "command -v fd",
      "command -v jq",
      "command -v ss",
      "command -v tmux",
      "command -v curl",
      "command -v git",
      "command -v gh",
      "command -v node",
      "command -v npm",
      "command -v bun",
      "command -v codex",
      `test "$(codex --version)" = "codex-cli ${CODEX_CLI_VERSION}"`,
      "command -v codex-acp",
      `test "$(codex-acp --version)" = "@agentclientprotocol/codex-acp ${CODEX_ACP_ADAPTER_VERSION}"`,
      "command -v claude",
      `claude --version | grep -F "${CLAUDE_CODE_CLI_VERSION}"`,
      "command -v claude-agent-acp",
      `test "$(claude-agent-acp --version)" = "${CLAUDE_CODE_ACP_ADAPTER_VERSION}"`,
      "command -v playwright",
      "playwright --version",
    ].join(" && "),
    root,
  )
  .runCmd(
    [
      "export DEBIAN_FRONTEND=noninteractive",
      "playwright install-deps chromium",
      "rm -rf /var/lib/apt/lists/*",
    ].join(" && "),
    root,
  )
  .runCmd(
    [
      "export HOME=/home/user",
      "playwright install chromium",
      "command -v playwright",
      "playwright --version",
      "playwright screenshot --browser chromium about:blank /tmp/playwright-chromium-smoke.png",
      "rm -f /tmp/playwright-chromium-smoke.png",
    ].join(" && "),
    user,
  )
  .runCmd(["id -nG | tr ' ' '\\n' | grep -qx docker", "docker version"].join(" && "), user);
