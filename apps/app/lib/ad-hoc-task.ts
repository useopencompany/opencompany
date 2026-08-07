export const AD_HOC_TASK_ID = "task";
export const AD_HOC_TASK_TOKEN = `#${AD_HOC_TASK_ID}` as const;

const AD_HOC_TASK_TOKEN_PATTERN = /(^|\s)#task(?=\s|$)/i;
const AD_HOC_TASK_DIRECTIVE_PATTERN = /(^|\s)#task(?:\s+|$)/i;

export function hasAdHocTaskToken(value: string): boolean {
  return AD_HOC_TASK_TOKEN_PATTERN.test(value);
}

export function descriptionFromAdHocTaskPrompt(value: string): string {
  return value.replace(AD_HOC_TASK_DIRECTIVE_PATTERN, "$1").trim();
}
