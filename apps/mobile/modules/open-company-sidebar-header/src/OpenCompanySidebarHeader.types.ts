import type { NativeSyntheticEvent, ViewProps } from "react-native";

interface HeightEvent {
  height: number;
}

export interface NativeOpenCompanySidebarHeaderViewProps extends ViewProps {
  onHeaderHeightChange?: (event: NativeSyntheticEvent<HeightEvent>) => void;
  onSearchPress?: () => void;
  scrollViewTestID: string;
  searchAccessibilityLabel: string;
  topInset: number;
}
