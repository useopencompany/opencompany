import { serializeAgentFile } from "@opencompany/agent-runtime";
import { describe, expect, test } from "vitest";
import { hashAgentSource } from "./hash";

describe("hashAgentSource", () => {
  test("hashes serialized agent source deterministically", () => {
    const source = serializeAgentFile({
      title: "Research",
      body: "Find people with @exa.",
    });

    expect(hashAgentSource(source)).toBe(hashAgentSource(source));
    expect(hashAgentSource(source)).not.toBe(hashAgentSource(source.replace("@exa", "@deep")));
  });
});
