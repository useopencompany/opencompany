import { requireNativeView } from "expo";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ViewProps } from "react-native";
import { View } from "react-native";
import { withUniwind } from "uniwind";

import type { NativeOpenCompanySidebarHeaderViewProps } from "./OpenCompanySidebarHeader.types";

const NativeView = requireNativeView<NativeOpenCompanySidebarHeaderViewProps>(
  "OpenCompanySidebarHeader",
);
const StyledNativeView = withUniwind(NativeView);

// UIKit reports the actual bar height immediately after mount. This value only
// prevents the scroll content from jumping during that first native layout.
export const SIDEBAR_HEADER_INITIAL_HEIGHT = 44;

export function OpenCompanySidebarHeader({
  leading,
  onHeightChange,
  onSearchPress,
  scrollViewTestID,
  searchAccessibilityLabel = "Search",
  style,
  topInset,
  ...viewProps
}: Omit<ViewProps, "children"> & {
  leading?: ReactNode;
  onHeightChange?: (height: number) => void;
  onSearchPress?: () => void;
  scrollViewTestID: string;
  searchAccessibilityLabel?: string;
  topInset: number;
}) {
  const [height, setHeight] = useState(topInset + SIDEBAR_HEADER_INITIAL_HEIGHT);

  return (
    <View {...viewProps} style={[style, { height }]}>
      <StyledNativeView
        className="flex-1 self-stretch"
        collapsable={false}
        onHeaderHeightChange={({ nativeEvent }) => {
          setHeight(nativeEvent.height);
          onHeightChange?.(nativeEvent.height);
        }}
        onSearchPress={onSearchPress}
        scrollViewTestID={scrollViewTestID}
        searchAccessibilityLabel={searchAccessibilityLabel}
        topInset={topInset}
      />
      {leading ? (
        <View
          pointerEvents="box-none"
          className="absolute left-5 justify-center"
          style={{ top: topInset, height: Math.max(0, height - topInset) }}
        >
          {leading}
        </View>
      ) : null}
    </View>
  );
}
