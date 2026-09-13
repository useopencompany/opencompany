import { parseArgs } from "node:util";
import { AGENT_MODEL_CATALOG } from "@opencompany/agent-runtime";
import { CHAT_FRONTIER_MODEL, CHAT_PDF_MODEL, CHAT_STANDARD_MODEL } from "../src/chat-model-router";
import { scenarios } from "./scenarios";
import type { Variant } from "./types";

export const DEFAULT_MODELS = [
  ...new Set([CHAT_STANDARD_MODEL, CHAT_FRONTIER_MODEL, CHAT_PDF_MODEL]),
];
export function parseCli(args: string[]) {
  // node:util parseArgs has no optional string values.
  const normalized = args
    .filter((arg) => arg !== "--")
    .flatMap((arg, index, original) =>
      ["--save-baseline", "--compare"].includes(arg) &&
      (!original[index + 1] || original[index + 1]!.startsWith("--"))
        ? [arg, ".context/bench/baseline.json"]
        : [arg],
    );
  const { values } = parseArgs({
    args: normalized,
    strict: true,
    options: {
      list: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      scenarios: { type: "string" },
      models: { type: "string" },
      k: { type: "string" },
      variant: { type: "string" },
      "save-baseline": { type: "string" },
      compare: { type: "string" },
      "budget-usd": { type: "string" },
      concurrency: { type: "string" },
      resume: { type: "string" },
    },
  });
  const number = (value: string | undefined, fallback: number, name: string, integer = true) => {
    const result = value === undefined ? fallback : Number(value);
    if (
      !Number.isFinite(result) ||
      result < (name === "budget-usd" ? 0 : 1) ||
      (integer && !Number.isSafeInteger(result))
    )
      throw new Error(
        `--${name} must be a ${integer ? "positive integer" : "non-negative number"}.`,
      );
    return result;
  };
  const split = (value: string) => [...new Set(value.split(",").map((v) => v.trim()))];
  const selectors = values.scenarios ? split(values.scenarios) : [];
  for (const selector of selectors)
    if (
      !scenarios.some(
        (s) =>
          s.id === selector || (selector.startsWith("tag:") && s.tags.includes(selector.slice(4))),
      )
    )
      throw new Error(`Unknown scenario or tag: ${selector}`);
  const selectedScenarios = selectors.length
    ? scenarios.filter((s) =>
        selectors.some(
          (sel) => s.id === sel || (sel.startsWith("tag:") && s.tags.includes(sel.slice(4))),
        ),
      )
    : scenarios;
  const models = values.models ? split(values.models) : DEFAULT_MODELS;
  for (const model of models)
    if (!AGENT_MODEL_CATALOG.some((m) => m.id === model))
      throw new Error(`Unknown model catalog id: ${model}`);
  const variants = values.variant ? split(values.variant) : ["v5"];
  for (const variant of variants)
    if (!["v4", "v5"].includes(variant)) throw new Error(`Unknown variant: ${variant}`);
  return {
    list: values.list,
    help: values.help,
    scenarios: selectedScenarios,
    models,
    variants: variants as Variant[],
    k: number(values.k, 4, "k"),
    budgetUsd: number(values["budget-usd"], 5, "budget-usd", false),
    concurrency: number(values.concurrency, 1, "concurrency"),
    saveBaseline: values["save-baseline"],
    compare: values.compare,
    resume: values.resume,
    explicit: values,
  };
}
export const HELP = `Harness bench (metered; all integration executions are fixtures)
  bun run bench [--list] [--scenarios id,id|tag:safety] [--models id,id]
    [--k 4] [--variant v4,v5] [--budget-usd 5] [--concurrency 1]
    [--save-baseline [path]] [--compare [path]] [--resume path]
Defaults: all 9 scenarios, router answer models + Sonnet, v5, k=4.
Reports and default baseline: .context/bench/ (repository root).
Resume inherits the saved configuration; --budget-usd is the cumulative cap.
Gateway charges arrive after responses: in-flight calls may cross the cap.
Exit: 0 pass/list, 1 failed trials, 2 stopped/incomplete, 3 invalid configuration.`;
