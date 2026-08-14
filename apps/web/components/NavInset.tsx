"use client";

import { createContext, useContext } from "react";

// True while the shell's floating menu/expand button covers the top-left of the main panel,
// so page chrome (e.g. the Brain header) can reserve left padding for it.
const NavInsetContext = createContext(false);

export const NavInsetProvider = NavInsetContext.Provider;

export function useNavInset() {
  return useContext(NavInsetContext);
}
