export const DOPPLER_CLI_VERSION = "3.76.5";
export const DOPPLER_CLI_LINUX_AMD64_SHA256 =
  "1b2f412d984920d665daf233ab6c15b364df9339b5c5b5224d5e8ee4e0a70154";

export const DOPPLER_INSTALL_COMMAND = [
  "doppler_install_dir=$(mktemp -d /tmp/opencompany-doppler.XXXXXX)",
  `curl -fsSL https://github.com/DopplerHQ/cli/releases/download/${DOPPLER_CLI_VERSION}/doppler_${DOPPLER_CLI_VERSION}_linux_amd64.tar.gz -o "$doppler_install_dir/doppler.tar.gz"`,
  `printf '%s  %s\\n' '${DOPPLER_CLI_LINUX_AMD64_SHA256}' "$doppler_install_dir/doppler.tar.gz" | sha256sum -c -`,
  'tar -xzf "$doppler_install_dir/doppler.tar.gz" -C "$doppler_install_dir" doppler',
  'install -m 0755 "$doppler_install_dir/doppler" /usr/local/bin/doppler',
  'rm -rf "$doppler_install_dir"',
  `test "$(doppler --version)" = "v${DOPPLER_CLI_VERSION}"`,
].join(" && ");
