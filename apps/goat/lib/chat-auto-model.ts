export const AUTO_GOAT_MODEL_SELECTION = "auto" as const;

export type AutoGoatModelSelection = typeof AUTO_GOAT_MODEL_SELECTION;

export const AUTO_GOAT_MODEL_ATTACHMENT_CAPABILITIES = {
  images: true,
  pdf: true,
} as const;

export function isAutoGoatModelSelection(value: unknown): value is AutoGoatModelSelection {
  return value === AUTO_GOAT_MODEL_SELECTION;
}
