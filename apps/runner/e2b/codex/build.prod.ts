import "dotenv/config";
import { defaultBuildLogger, Template } from "e2b";
import {
  CODEX_TOOLBOX_CPU_COUNT,
  CODEX_TOOLBOX_MEMORY_MB,
  CODEX_TOOLBOX_TEMPLATE_ALIAS,
  template,
} from "./template";

await Template.build(template, CODEX_TOOLBOX_TEMPLATE_ALIAS, {
  cpuCount: CODEX_TOOLBOX_CPU_COUNT,
  memoryMB: CODEX_TOOLBOX_MEMORY_MB,
  onBuildLogs: defaultBuildLogger(),
});
