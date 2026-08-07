export const AUTO_GOAT_MODEL_SELECTION = "auto" as const;

export type AutoModelSelection = typeof AUTO_GOAT_MODEL_SELECTION;

export const AUTO_GOAT_MODEL_ATTACHMENT_CAPABILITIES = {
  images: true,
  pdf: true,
} as const;

export function isAutoModelSelection(value: unknown): value is AutoModelSelection {
  return value === AUTO_GOAT_MODEL_SELECTION;
}
