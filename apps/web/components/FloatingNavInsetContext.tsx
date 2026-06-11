"use client";

import { createContext, useContext } from "react";

// When a surface floats an "expand sidebar" control over the top-left of the main panel (the
// /personal shell does this while collapsed), the panel's own top bar must reserve left padding so
// its leading content doesn't sit underneath that button. This context carries that signal down to
// shared chrome (e.g. SessionView's top bar) without threading props through route pages. Defaults
// to false, so surfaces that don't float such a control — the main workspace — are unaffected.
const FloatingNavInsetContext = createContext(false);

export const FloatingNavInsetProvider = FloatingNavInsetContext.Provider;

export function useFloatingNavInset() {
  return useContext(FloatingNavInsetContext);
}
