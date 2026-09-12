import { NativeModules, Platform } from "react-native";
import { initialWindowMetrics } from "react-native-safe-area-context";

/**
 * Radius used to round the drawer's screen content so its corners line up with
 * the physical display corners while the drawer is open. Pair it with
 * `borderCurve: 'continuous'` — the display's corners are a superellipse, not a
 * circular arc, so a plain `borderRadius` visibly diverges along the edges.
 *
 * The real value is per-device (39–62pt across the iPhone line) and Apple only
 * exposes it through `UIScreen._displayCornerRadius`.
 * `react-native-screen-corner-radius` reads that behind an obfuscated selector
 * and hands it over as a legacy bridge module constant.
 *
 * We read the constant off `NativeModules` rather than importing the package's
 * own entry point: that entry point dereferences the native module at import
 * time, so it throws on any JS reload that happens before the native rebuild
 * lands. The dependency is still required — it's what registers the module.
 */

/**
 * Devices with a square display (SE, older bezelled iPhones) report a ~20pt top
 * inset for the status bar; anything taller means a notch or Dynamic Island,
 * and therefore rounded display corners. Used to tell a legitimate `0` (square
 * display) apart from a `0` that means the private selector stopped working.
 */
const hasRoundedDisplay = (initialWindowMetrics?.insets.top ?? 0) > 20;

/**
 * Deliberately conservative: under-rounding is invisible when the drawer is
 * closed, because the display's own mask clips the corners anyway. Over-
 * rounding cuts visible notches out of the corners at all times.
 */
const FALLBACK_RADIUS = 44;

function resolveScreenCornerRadius(): number {
  if (Platform.OS !== "ios") {
    return 0;
  }

  const reported: unknown = NativeModules.ScreenCornerRadius?.cornerRadius;

  if (typeof reported === "number" && reported > 0) {
    return reported;
  }

  return hasRoundedDisplay ? FALLBACK_RADIUS : 0;
}

export const SCREEN_CORNER_RADIUS = resolveScreenCornerRadius();
