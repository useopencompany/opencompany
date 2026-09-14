import "dotenv/config";
import { defaultBuildLogger, Template } from "e2b";
import { CODEX_TOOLBOX_TEMPLATE_BUILDS, template } from "./template";

// One alias per sandbox size, built from the same image definition. Builds run in
// sequence so the shared layers come from cache instead of racing three cold builds.
for (const build of CODEX_TOOLBOX_TEMPLATE_BUILDS) {
  console.log(`Building ${build.alias} (${build.cpuCount} vCPU, ${build.memoryMB} MB)`);
  await Template.build(template, build.alias, {
    cpuCount: build.cpuCount,
    memoryMB: build.memoryMB,
    onBuildLogs: defaultBuildLogger(),
  });
}
