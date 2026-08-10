import {
  type ElectricCollectionConfig,
  electricCollectionOptions,
} from "@tanstack/electric-db-collection";
import { createCollection } from "@tanstack/react-db";

function shapeProxyUrl(): string {
  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : (process.env.GOAT_NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ?? "");
  return `${origin}/api/electric/v1/shape`;
}

type ShapeParams = Record<string, string>;
type ElectricOpts<TRow extends Record<string, unknown>> = ElectricCollectionConfig<TRow>;

export function createGoatElectricCollection<TRow extends Record<string, unknown>>(config: {
  id: string;
  table: string;
  getKey: (row: TRow) => string | number;
  params?: ShapeParams;
  onInsert?: ElectricOpts<TRow>["onInsert"];
  onUpdate?: ElectricOpts<TRow>["onUpdate"];
  onDelete?: ElectricOpts<TRow>["onDelete"];
}) {
  return createCollection(
    electricCollectionOptions<TRow>({
      id: config.id,
      shapeOptions: {
        url: shapeProxyUrl(),
        params: {
          table: config.table,
          ...config.params,
        },
      },
      getKey: config.getKey,
      ...(config.onInsert ? { onInsert: config.onInsert } : {}),
      ...(config.onUpdate ? { onUpdate: config.onUpdate } : {}),
      ...(config.onDelete ? { onDelete: config.onDelete } : {}),
    }),
  );
}

export type GoatElectricCollection<TRow extends Record<string, unknown>> = ReturnType<
  typeof createGoatElectricCollection<TRow>
>;
