import { createCollection } from "@tanstack/react-db";
import {
  type ElectricCollectionConfig,
  electricCollectionOptions,
} from "@tanstack/electric-db-collection";

/**
 * Absolute URL of our same-origin auth proxy (see
 * app/api/electric/v1/shape/route.ts). Electric's ShapeStream builds a
 * `new URL(url)`, so it must be absolute — a relative path throws
 * `ERR_INVALID_URL`. Collections only sync on the client (live queries are
 * client-only), so `window.location.origin` is always available at sync time;
 * the SSR fallback to NEXT_PUBLIC_APP_URL keeps creation from throwing.
 */
function shapeProxyUrl(): string {
  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ?? "");
  return `${origin}/api/electric/v1/shape`;
}

type ShapeParams = Record<string, string>;

// The exact config the Electric collection accepts for this row type. We derive
// the write-handler types from it (rather than hand-rolling them) so onInsert/
// onUpdate/onDelete match the library's per-operation mutation params exactly
// and return the expected `{ txid } | void`.
type ElectricOpts<TRow extends Record<string, unknown>> = ElectricCollectionConfig<TRow>;

/**
 * Build an Electric-backed collection that points at our proxy.
 *
 * `table` is sent as a hint the proxy validates against its allow-list (the
 * proxy re-sets the trusted table name); any extra `params` (e.g. session_id)
 * are forwarded for the proxy to authorize and translate into a WHERE clause.
 * The authoritative `where`/`workspace_id`/`user_id` scoping is applied
 * server-side, never here.
 */
export function createElectricCollection<TRow extends Record<string, unknown>>(config: {
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

export type ElectricCollection<TRow extends Record<string, unknown>> = ReturnType<
  typeof createElectricCollection<TRow>
>;
