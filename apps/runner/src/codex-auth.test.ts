import { describe, expect, it } from "vitest";
import { parseDeviceLoginDetails } from "./codex-auth";

describe("parseDeviceLoginDetails", () => {
  it("extracts the OpenAI verification URL and user code from Codex CLI output", () => {
    expect(
      parseDeviceLoginDetails(`
To sign in, visit https://chatgpt.com/activate and enter code:

ABCD-EFGH
`),
    ).toEqual({
      verificationUri: "https://chatgpt.com/activate",
      userCode: "ABCD-EFGH",
      browserAuthFallback: false,
    });
  });

  it("accepts alternate code formatting", () => {
    expect(
      parseDeviceLoginDetails("Open https://auth.openai.com/device, then use code: abc12345"),
    ).toEqual({
      verificationUri: "https://auth.openai.com/device",
      userCode: "ABC12345",
      browserAuthFallback: false,
    });
  });

  it("extracts ANSI-colored Codex CLI device output", () => {
    expect(
      parseDeviceLoginDetails(`
Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m

2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m
   \u001b[94m6MZJ-7O6QK\u001b[0m
`),
    ).toEqual({
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "6MZJ-7O6QK",
      browserAuthFallback: false,
    });
  });

  it("does not treat browser OAuth authorization text as a device code", () => {
    expect(
      parseDeviceLoginDetails(
        "Open https://auth.openai.com/oauth/authorize?response_type=code&code_challenge=abc and complete authorization.",
      ),
    ).toEqual({
      verificationUri: null,
      userCode: null,
      browserAuthFallback: true,
    });
  });
});
