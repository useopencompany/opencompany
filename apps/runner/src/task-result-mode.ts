// Harness specs are persisted, so tasks created before the legacy Brain was
// retired still carry a "save the report to Brain" contract inside their stored
// system prompt. Strip it on every replay: there is nowhere to save it now, and
// leaving it in would make the model promise a Brain file it cannot produce.
const BRAIN_REPORT_CONTRACT_START = "<brain_markdown_report_result_contract>";
const BRAIN_REPORT_CONTRACT_END = "</brain_markdown_report_result_contract>";

export function systemPromptForTaskResultMode(systemPrompt: string) {
  return removeBrainReportContracts(systemPrompt);
}

export function systemBlocksForTaskResultMode(systemBlocks: readonly string[]) {
  return systemBlocks.map(removeBrainReportContracts).filter(Boolean);
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
