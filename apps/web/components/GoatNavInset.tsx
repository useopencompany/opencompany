"use client";

import { createContext, useContext } from "react";

// True while the shell's floating menu/expand button covers the top-left of the main panel,
// so page chrome (e.g. the Brain header) can reserve left padding for it.
const GoatNavInsetContext = createContext(false);

export const GoatNavInsetProvider = GoatNavInsetContext.Provider;

export function useGoatNavInset() {
  return useContext(GoatNavInsetContext);
}
