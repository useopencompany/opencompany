import { describe, expect, it, vi } from "vitest";
import {
  collectRepositoryEvidence,
  pluginSignalReasons,
  recommendRepositoryPlugins,
  selectRepositorySetupFiles,
} from "./repository-plugin-scan";

const tree = [
  "package.json",
  "apps/web/package.json",
  "apps/web/src/app/page.tsx",
  "packages/db/package.json",
  "packages/db/src/deep/nested/package.json",
  "node_modules/stripe/package.json",
  "examples/demo/package.json",
  "services/api/pyproject.toml",
  "render.yaml",
  ".infisical.json",
  ".env.example",
  "apps/web/.env.local",
].map((path) => ({ path, size: 100 }));

const files = [
  {
    path: "apps/web/package.json",
    text: JSON.stringify({ dependencies: { next: "16", "posthog-js": "1" } }),
  },
  {
    path: "packages/db/package.json",
    text: JSON.stringify({ dependencies: { "@neondatabase/serverless": "1" } }),
  },
  {
    path: "services/api/pyproject.toml",
    text: '[project]\ndependencies = [\n  "stripe>=9",\n  "fastapi",\n]\n',
  },
  {
    path: ".env.example",
    text: "RESEND_API_KEY=re_live_should_never_be_read\n# COMMENTED=1\nexport APP_URL=\n",
  },
];

describe("selectRepositorySetupFiles", () => {
  it("keeps shallow manifests and env templates, skipping vendored, example, and secret files", () => {
    expect(selectRepositorySetupFiles(tree)).toEqual([
      ".env.example",
      "package.json",
      "apps/web/package.json",
      "packages/db/package.json",
      "services/api/pyproject.toml",
    ]);
  });

  it("skips files too large to be a manifest", () => {
    expect(selectRepositorySetupFiles([{ path: "package.json", size: 10 * 1024 * 1024 }])).toEqual(
      [],
    );
  });
});

describe("collectRepositoryEvidence", () => {
  it("keeps dependency and variable names but never env values", () => {
    const evidence = collectRepositoryEvidence({ paths: tree.map(({ path }) => path), files });
    expect(evidence.dependencies).toEqual([
      { manifest: "apps/web/package.json", names: ["next", "posthog-js"] },
      { manifest: "packages/db/package.json", names: ["@neondatabase/serverless"] },
      { manifest: "services/api/pyproject.toml", names: ["stripe", "fastapi"] },
    ]);
    expect(evidence.envNames).toEqual(["RESEND_API_KEY", "APP_URL"]);
    expect(JSON.stringify(evidence)).not.toContain("re_live");
    expect(evidence.configFiles).toEqual(["render.yaml", ".infisical.json"]);
  });

  it("explains each detected plugin with the evidence that points at it", () => {
    const reasons = pluginSignalReasons(
      collectRepositoryEvidence({ paths: tree.map(({ path }) => path), files }),
    );
    expect(Object.fromEntries(reasons)).toEqual({
      posthog: "posthog-js in apps/web/package.json",
      render: "render.yaml",
      stripe: "stripe in services/api/pyproject.toml",
      neon: "@neondatabase/serverless in packages/db/package.json",
      resend: "RESEND_API_KEY in your env template",
      infisical: ".infisical.json",
    });
  });
});

describe("recommendRepositoryPlugins", () => {
  const evidence = collectRepositoryEvidence({ paths: tree.map(({ path }) => path), files });

  it("lets Jev decide and keeps the matching reason", async () => {
    const evaluator = vi.fn(async (request: { questions: Record<string, unknown> }) => ({
      answers: Object.fromEntries(
        Object.keys(request.questions).map((plugin) => [
          plugin,
          {
            type: "boolean",
            probability: plugin === "posthog" || plugin === "supabase" ? 0.95 : 0.1,
          },
        ]),
      ),
    }));

    const result = await recommendRepositoryPlugins(
      { evidence, apiKey: "test-key" },
      evaluator as never,
    );

    expect(result).toEqual({
      plugins: [
        { plugin: "posthog", reason: "posthog-js in apps/web/package.json" },
        { plugin: "supabase", reason: "Found in your setup files" },
      ],
      recommendedBy: "jev",
    });
    const request = evaluator.mock.calls[0]![0] as { state: string };
    expect(request.state).not.toContain("re_live");
  });

  it("falls back to the fixed signals when Jev is unavailable", async () => {
    const result = await recommendRepositoryPlugins(
      { evidence, apiKey: "test-key" },
      vi.fn(async () => {
        throw new Error("503 Service temporarily unavailable");
      }) as never,
    );
    expect(result.recommendedBy).toBe("rules");
    expect(result.plugins.map(({ plugin }) => plugin)).toEqual([
      "posthog",
      "render",
      "stripe",
      "neon",
      "resend",
      "infisical",
    ]);
  });

  it("does not call the model for a repository with nothing to read", async () => {
    const evaluator = vi.fn();
    const result = await recommendRepositoryPlugins(
      { evidence: { dependencies: [], configFiles: [], envNames: [] }, apiKey: "test-key" },
      evaluator as never,
    );
    expect(result).toEqual({ plugins: [], recommendedBy: "rules" });
    expect(evaluator).not.toHaveBeenCalled();
  });
});
