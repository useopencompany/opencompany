import { SymbolView } from "expo-symbols";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { withUniwind } from "uniwind";

type StyledSymbolViewProps = ComponentPropsWithRef<typeof SymbolView> & {
  tintColorClassName?: string;
};

export const StyledSymbolView: (props: StyledSymbolViewProps) => ReactNode =
  withUniwind(SymbolView);
