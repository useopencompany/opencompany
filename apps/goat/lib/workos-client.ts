// Kept separate from lib/workos.ts so modules that only need URL helpers do
// not pull in @workos-inc/authkit-nextjs (whose ESM build breaks vitest).
import { getWorkOS } from "@workos-inc/authkit-nextjs";

export function getWorkOSClient() {
  return getWorkOS();
}
