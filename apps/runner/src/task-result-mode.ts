import type { TaskResultMode } from "@opencompany/db/product-schema";

const BRAIN_REPORT_CONTRACT_START = "<brain_markdown_report_result_contract>";
const BRAIN_REPORT_CONTRACT_END = "</brain_markdown_report_result_contract>";

const BRAIN_REPORT_CONTRACT = [
  BRAIN_REPORT_CONTRACT_START,
  "Finish with only the complete Markdown report body.",
  "Do not include conversational framing, delivery notes, or a separate summary outside the report.",
  "Use a clear H1 title, concise executive summary, sourced findings, uncertainty, and practical next steps when relevant.",
  "The harness will save this final Markdown as a .md file in the user's Brain and return the file link as the task result.",
  BRAIN_REPORT_CONTRACT_END,
].join("\n");

export function systemPromptForTaskResultMode(systemPrompt: string, resultMode: TaskResultMode) {
  const basePrompt = removeBrainReportContracts(systemPrompt);
  return resultMode === "brain_markdown_report"
    ? [basePrompt, BRAIN_REPORT_CONTRACT].filter(Boolean).join("\n\n")
    : basePrompt;
}

export function systemBlocksForTaskResultMode(
  systemBlocks: readonly string[],
  resultMode: TaskResultMode,
) {
  const baseBlocks = systemBlocks.map(removeBrainReportContracts).filter(Boolean);
  return resultMode === "brain_markdown_report"
    ? [...baseBlocks, BRAIN_REPORT_CONTRACT]
    : baseBlocks;
}

function removeBrainReportContracts(systemPrompt: string) {
  let prompt = systemPrompt.trim();
  let start = prompt.indexOf(BRAIN_REPORT_CONTRACT_START);
  while (start >= 0) {
    const end = prompt.indexOf(BRAIN_REPORT_CONTRACT_END, start);
    if (end < 0) break;
    const before = prompt.slice(0, start).trimEnd();
    const after = prompt.slice(end + BRAIN_REPORT_CONTRACT_END.length).trimStart();
    prompt = [before, after].filter(Boolean).join("\n\n");
    start = prompt.indexOf(BRAIN_REPORT_CONTRACT_START);
  }
  return prompt.trim();
}
