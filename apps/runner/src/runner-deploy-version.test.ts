import { describe, expect, it } from "vitest";
import { recoveryReasonForDeployVersions, runnerDeployVersion } from "./runner-deploy-version";

describe("runnerDeployVersion", () => {
  it("prefers the Render commit and has a stable local fallback", () => {
    expect(
      runnerDeployVersion({
        RENDER_GIT_COMMIT: "commit_1",
        OBSERVABILITY_RELEASE: "release_1",
      } as NodeJS.ProcessEnv),
    ).toBe("commit_1");
    expect(runnerDeployVersion({} as NodeJS.ProcessEnv)).toBe("local");
  });

  it("classifies only a known version change as a cross-deploy recovery", () => {
    expect(recoveryReasonForDeployVersions({ current: "v2", previous: "v1" })).toBe("cross_deploy");
    expect(recoveryReasonForDeployVersions({ current: "v2", previous: "v2" })).toBe(
      "lease_reclaimed",
    );
    expect(recoveryReasonForDeployVersions({ current: "v2", previous: null })).toBe(
      "lease_reclaimed",
    );
  });
});
