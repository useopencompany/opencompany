import { parseGitHubCliArgs } from "@opencompany/agent-runtime";
import {
  AFTER_SESSION_TOOL_NAME,
  type RuntimeToolCall,
  readString,
} from "@/lib/agent-sessions/runtime-events";

export type ToolCallDisplay = {
  label: string;
  title: string;
  icon: "brain" | "file" | "search" | "terminal" | "tool";
  detail?: ToolCallDisplayDetailModel | undefined;
};

export type ToolCallDisplayDetailModel = {
  label: string;
  title?: string | undefined;
  kind: "command" | "file" | "muted";
};

export function toolCallDisplay(toolCall: RuntimeToolCall): ToolCallDisplay {
  if (toolCall.name === AFTER_SESSION_TOOL_NAME) {
    return {
      label: toolCall.label || formatToolName(toolCall.name),
      title: toolCall.name,
      icon: "brain",
    };
  }

  if (toolCall.name === "shell") {
    return shellToolCallDisplay(toolCall);
  }

  const readDisplay = readToolCallDisplay(toolCall);
  if (readDisplay) return readDisplay;

  const filePath = toolInputString(toolCall.inputPreview, "path");
  if (
    filePath &&
    (toolCall.name === "write_file" ||
      toolCall.name === "edit_file" ||
      toolCall.name === "list_files")
  ) {
    return {
      label: toolCall.label || formatToolName(toolCall.name),
      title: toolCall.name,
      icon: "file",
      detail: fileDetail(filePath),
    };
  }

  return {
    label: toolCall.label || formatToolName(toolCall.name),
    title: toolCall.name,
    icon: "tool",
  };
}

function readToolCallDisplay(toolCall: RuntimeToolCall): ToolCallDisplay | null {
  if (toolCall.name !== "read_file" && toolCall.name !== "read_skill") return null;

  const output = parsePreviewRecord(toolCall.outputPreview);
  const inputPath = toolInputString(toolCall.inputPreview, "path");
  const outputPath = readString(output?.path);
  const skillId = toolInputString(toolCall.inputPreview, "skillId");
  const path = outputPath || inputPath || (skillId ? `${skillId}/SKILL.md` : "");
  const content = readString(output?.content);
  const lineCount = content
    ? countLines(content)
    : toolCall.status === "completed"
      ? countPreviewLines(toolCall.outputPreview)
      : 0;

  return {
    label: lineCount ? `Read ${formatLineCount(lineCount)}` : toolCall.label || "Read file",
    title: toolCall.name,
    icon: "file",
    ...(path ? { detail: fileDetail(path) } : {}),
  };
}

function shellToolCallDisplay(toolCall: RuntimeToolCall): ToolCallDisplay {
  const rawCommand =
    toolCall.command ||
    toolInputString(toolCall.inputPreview, "command") ||
    toolInputString(toolCall.inputPreview, "cmd");
  const command = unwrapBashLoginCommand(rawCommand) || rawCommand;
  const argv = command ? parseGitHubCliArgs(command) : null;

  const readCommand = argv ? readCommandDisplay(argv, toolCall.outputPreview) : null;
  if (readCommand) {
    return {
      label: `Read ${formatLineCount(readCommand.lineCount)}`,
      title: rawCommand || toolCall.name,
      icon: "file",
      detail: fileDetail(readCommand.path),
    };
  }

  const grepCommand = argv ? grepCommandDisplay(argv, toolCall.outputPreview) : null;
  if (grepCommand) {
    return {
      label: grepCommand.location
        ? `grep for '${grepCommand.pattern}' in ${grepCommand.location}`
        : `grep for '${grepCommand.pattern}'`,
      title: rawCommand || toolCall.name,
      icon: "search",
      detail: {
        label: `${grepCommand.matches} ${grepCommand.matches === 1 ? "match" : "matches"}`,
        kind: "muted",
      },
    };
  }

  return {
    label: "Bash",
    title: rawCommand || toolCall.name,
    icon: "terminal",
    ...(command
      ? {
          detail: {
            label: truncateInline(command, 96),
            title: command,
            kind: "command" as const,
          },
        }
      : {}),
  };
}

function readCommandDisplay(argv: string[], outputPreview: string) {
  const command = basename(argv[0] ?? "");
  if (!command) return null;

  if (command === "sed") {
    const range = sedPrintRange(argv);
    const path = firstPathAfterSedScript(argv);
    if (path && range) {
      return { path, lineCount: Math.max(range.end - range.start + 1, 1) };
    }
    if (path) return { path, lineCount: countPreviewLines(outputPreview) || 1 };
  }

  if (command === "cat") {
    const path = firstNonOptionArg(argv, 1);
    if (path) return { path, lineCount: countPreviewLines(outputPreview) || 1 };
  }

  if (command === "head" || command === "tail") {
    const requestedCount = lineCountOption(argv);
    const path = lastNonOptionArg(argv, 1);
    if (path) return { path, lineCount: requestedCount || countPreviewLines(outputPreview) || 1 };
  }

  if (command === "nl") {
    const path = firstNonOptionArg(argv, 1);
    if (path) return { path, lineCount: countPreviewLines(outputPreview) || 1 };
  }

  return null;
}

function grepCommandDisplay(argv: string[], outputPreview: string) {
  const command = basename(argv[0] ?? "");
  if (command !== "rg" && command !== "grep") return null;

  const parsed = parseSearchCommandArgs(argv);
  if (!parsed?.pattern) return null;
  const matches = countPreviewLines(outputPreview);
  return {
    pattern: truncateInline(parsed.pattern, 80),
    location: parsed.path ? shortPathLabel(parsed.path) : "",
    matches,
  };
}

function parseSearchCommandArgs(argv: string[]) {
  const args = argv.slice(1);
  const positional: string[] = [];
  const optionsWithValue = new Set([
    "-A",
    "-B",
    "-C",
    "-e",
    "-f",
    "-g",
    "-m",
    "--after-context",
    "--before-context",
    "--context",
    "--glob",
    "--max-count",
    "--regexp",
    "--type",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg || arg === "|") break;
    if (arg === "--") {
      positional.push(...args.slice(index + 1).filter((item) => item && item !== "|"));
      break;
    }
    if (optionsWithValue.has(arg)) {
      index += 1;
      continue;
    }
    if ([...optionsWithValue].some((option) => arg.startsWith(`${option}=`))) continue;
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }

  const [pattern, ...paths] = positional;
  return pattern ? { pattern, path: paths.at(-1) ?? "" } : null;
}

function sedPrintRange(argv: string[]) {
  for (const arg of argv) {
    const match = arg.match(/^(\d+),(\d+)p$/);
    if (!match) continue;
    return {
      start: Number.parseInt(match[1] ?? "0", 10),
      end: Number.parseInt(match[2] ?? "0", 10),
    };
  }
  return null;
}

function firstPathAfterSedScript(argv: string[]) {
  let sawScript = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg || arg === "|") break;
    if (arg === "-n") continue;
    if (!sawScript && /^(\d+),(\d+)p$/.test(arg)) {
      sawScript = true;
      continue;
    }
    if (sawScript && !arg.startsWith("-")) return arg;
  }
  return "";
}

function lineCountOption(argv: string[]) {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "-n" && argv[index + 1]) return Number.parseInt(argv[index + 1] ?? "0", 10) || 0;
    if (arg.startsWith("-n")) return Number.parseInt(arg.slice(2), 10) || 0;
  }
  return 0;
}

function firstNonOptionArg(argv: string[], startIndex: number) {
  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg || arg === "|") break;
    if (!arg.startsWith("-")) return arg;
  }
  return "";
}

function lastNonOptionArg(argv: string[], startIndex: number) {
  let result = "";
  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg || arg === "|") break;
    if (!arg.startsWith("-")) result = arg;
  }
  return result;
}

function unwrapBashLoginCommand(command: string) {
  const argv = parseGitHubCliArgs(command);
  if (!argv || argv.length < 3) return "";
  const binary = basename(argv[0] ?? "");
  if (binary !== "bash" && binary !== "sh" && binary !== "zsh") return "";
  const flag = argv[1] ?? "";
  if (!flag.includes("c")) return "";
  return argv.slice(2).join(" ").trim();
}

function toolInputString(inputPreview: string, key: string) {
  const record = parsePreviewRecord(inputPreview);
  return readString(record?.[key]).trim();
}

function parsePreviewRecord(preview: string): Record<string, unknown> | null {
  if (!preview) return null;
  try {
    const parsed = JSON.parse(preview) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function countPreviewLines(value: string) {
  const normalized = value.replace(/\r\n/g, "\n").trimEnd();
  if (!normalized) return 0;
  return normalized.split("\n").length;
}

function countLines(value: string) {
  return countPreviewLines(value);
}

function formatLineCount(count: number) {
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

function fileDetail(path: string): ToolCallDisplayDetailModel {
  return {
    label: shortPathLabel(path),
    title: path,
    kind: "file",
  };
}

function shortPathLabel(path: string) {
  const normalized = path.trim().replace(/\/+$/, "");
  return basename(normalized) || normalized;
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function truncateInline(value: string, maxLength: number) {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1)}...`;
}

function formatToolName(name: string) {
  const normalized = name.replace(/[_-]+/g, " ").trim();
  if (!normalized) return "Tool call";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}
