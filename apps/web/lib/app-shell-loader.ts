import { captureException } from "@opencompany/observability";

export async function loadOptionalAppShellData<T>(
  source: string,
  load: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    captureException(error, {
      event: "opencompany.web_app_shell_optional_load_failed",
      source,
    });
    return fallback;
  }
}
