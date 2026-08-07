export const GOAT_AD_HOC_TASK_ID = "task";
export const GOAT_AD_HOC_TASK_TOKEN = `#${GOAT_AD_HOC_TASK_ID}` as const;

const GOAT_AD_HOC_TASK_TOKEN_PATTERN = /(^|\s)#task(?=\s|$)/i;
const GOAT_AD_HOC_TASK_DIRECTIVE_PATTERN = /(^|\s)#task(?:\s+|$)/i;

export function hasAdHocTaskToken(value: string): boolean {
  return GOAT_AD_HOC_TASK_TOKEN_PATTERN.test(value);
}

export function descriptionFromAdHocTaskPrompt(value: string): string {
  return value.replace(GOAT_AD_HOC_TASK_DIRECTIVE_PATTERN, "$1").trim();
}
