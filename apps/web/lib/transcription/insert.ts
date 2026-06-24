export function insertTranscriptDraft(input: {
  value: string;
  transcript: string;
  selectionStart: number;
  selectionEnd: number;
}): { value: string; caret: number } {
  const transcript = input.transcript.trim();
  if (!transcript) return { value: input.value, caret: input.selectionEnd };

  const start = clampSelection(input.selectionStart, input.value.length);
  const end = clampSelection(input.selectionEnd, input.value.length);
  const before = input.value.slice(0, Math.min(start, end));
  const after = input.value.slice(Math.max(start, end));
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";
  const inserted = `${prefix}${transcript}${suffix}`;

  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + prefix.length + transcript.length,
  };
}

function clampSelection(value: number, max: number) {
  if (!Number.isFinite(value)) return max;
  return Math.max(0, Math.min(max, value));
}
