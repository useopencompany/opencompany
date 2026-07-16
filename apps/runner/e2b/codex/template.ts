import { Template } from "e2b";

export const CODEX_TOOLBOX_TEMPLATE_ALIAS = "opencompany-codex-toolbox";
export const CODEX_TOOLBOX_CPU_COUNT = 8;
export const CODEX_TOOLBOX_MEMORY_MB = 8192;
export const CODEX_CLI_VERSION = "0.144.5";
export const CODEX_CLI_PACKAGE = `@openai/codex@${CODEX_CLI_VERSION}`;
export const PLAYWRIGHT_PACKAGE = "playwright@1.60.0";
export const BUN_VERSION = "1.3.2";

const root = { user: "root" } as const;
const user = { user: "user" } as const;

export const template = Template()
  .fromTemplate("codex")
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
        "ripgrep",
        "fd-find",
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
      "if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then",
      "  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -;",
      "  export DEBIAN_FRONTEND=noninteractive;",
      "  apt-get update;",
      "  apt-get install -y --no-install-recommends nodejs;",
      "  rm -rf /var/lib/apt/lists/*;",
      "fi",
    ].join("\n"),
    root,
  )
  .runCmd(
    [
      `curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}"`,
      `test "$(bun --version)" = "${BUN_VERSION}"`,
      `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g ${CODEX_CLI_PACKAGE} ${PLAYWRIGHT_PACKAGE}`,
      "command -v rg",
      "command -v fd",
      "command -v jq",
      "command -v curl",
      "command -v git",
      "command -v gh",
      "command -v node",
      "command -v npm",
      "command -v bun",
      "command -v codex",
      `test "$(codex --version)" = "codex-cli ${CODEX_CLI_VERSION}"`,
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
  );
