import type { NativeSyntheticEvent, ViewProps } from "react-native";

interface HeightEvent {
  height: number;
}

interface SearchActiveEvent {
  active: boolean;
}

interface SearchValueEvent {
  value: string;
}

export interface NativeOpenCompanySidebarHeaderViewProps extends ViewProps {
  onHeaderHeightChange?: (event: NativeSyntheticEvent<HeightEvent>) => void;
  onSearchActiveChange?: (event: NativeSyntheticEvent<SearchActiveEvent>) => void;
  onSearchPress?: () => void;
  onSearchValueChange?: (event: NativeSyntheticEvent<SearchValueEvent>) => void;
  scrollViewTestID: string;
  searchAccessibilityLabel: string;
  topInset: number;
}
