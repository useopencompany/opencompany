import { describe, expect, it } from "vitest";
import { buildLocalCodexStandaloneLauncher } from "./local-codex-standalone-launcher";

describe("buildLocalCodexStandaloneLauncher", () => {
  it("builds a standalone Mac launcher that runs with node and codex", () => {
    const launcher = buildLocalCodexStandaloneLauncher({
      baseUrl: "https://goat.example.com/",
      token: "oc_goat_local_token",
      name: "Ada's Mac",
    });

    expect(launcher).toContain('<plist version="1.0">');
    expect(launcher).toContain("<key>CommandString</key>");
    expect(launcher).toContain("OpenCompany Goat Local Codex Bridge");

    const command = decodeXmlText(
      /<key>CommandString<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(launcher)?.[1] ?? "",
    );
    expect(command).toContain("/bin/zsh -c");
    expect(command).toContain("local-codex-bridge.mjs");
    expect(command).toContain("command -v node");
    expect(command).toContain("command -v codex");
    expect(command).toContain("--base-url");
    expect(command).toContain("https://goat.example.com");
    expect(command).toContain("--token");
    expect(command).toContain("oc_goat_local_token");
    expect(command).toContain("--name");
    expect(command).toContain("Ada");
    expect(launcher).not.toContain("@opencompany/goat-local-bridge");
    expect(launcher).not.toContain("apps/goat-local-bridge/package.json");
    expect(launcher).not.toContain("command -v bun");
  });
});

function decodeXmlText(value: string) {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
