import { requireNativeView } from "expo";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ViewProps } from "react-native";
import { View } from "react-native";
import Reanimated, { Keyframe } from "react-native-reanimated";
import { withUniwind } from "uniwind";

import type { NativeOpenCompanySidebarHeaderViewProps } from "./OpenCompanySidebarHeader.types";

const NativeView = requireNativeView<NativeOpenCompanySidebarHeaderViewProps>(
  "OpenCompanySidebarHeader",
);
const StyledNativeView = withUniwind(NativeView);

// UIKit reports the actual bar height immediately after mount. This value only
// prevents the scroll content from jumping during that first native layout.
export const SIDEBAR_HEADER_INITIAL_HEIGHT = 44;

const WORDMARK_ENTERING = new Keyframe({
  0: { opacity: 0 },
  100: { opacity: 1 },
})
  // UIKit reports search inactive before its dismissal animation finishes, so
  // delay the wordmark to avoid overlapping the collapsing search field.
  .delay(360)
  .duration(140);
const WORDMARK_EXITING = new Keyframe({
  0: { opacity: 1 },
  100: { opacity: 0 },
}).duration(100);

export function OpenCompanySidebarHeader({
  leading,
  onHeightChange,
  onSearchActiveChange,
  onSearchPress,
  onSearchValueChange,
  scrollViewTestID,
  searchAccessibilityLabel = "Search",
  style,
  topInset,
  ...viewProps
}: Omit<ViewProps, "children"> & {
  leading?: ReactNode;
  onHeightChange?: (height: number) => void;
  onSearchActiveChange?: (active: boolean) => void;
  onSearchPress?: () => void;
  onSearchValueChange?: (value: string) => void;
  scrollViewTestID: string;
  searchAccessibilityLabel?: string;
  topInset: number;
}) {
  const [height, setHeight] = useState(topInset + SIDEBAR_HEADER_INITIAL_HEIGHT);
  const [hasOpenedSearch, setHasOpenedSearch] = useState(false);
  const [isSearchActive, setIsSearchActive] = useState(false);

  return (
    <View {...viewProps} style={[style, { height }]}>
      {leading && !isSearchActive ? (
        <Reanimated.View
          pointerEvents="box-none"
          accessibilityElementsHidden={isSearchActive}
          entering={hasOpenedSearch ? WORDMARK_ENTERING : undefined}
          exiting={WORDMARK_EXITING}
          className="absolute left-5 justify-center"
          style={{ top: topInset, height: Math.max(0, height - topInset) }}
        >
          {leading}
        </Reanimated.View>
      ) : null}
      <StyledNativeView
        className="flex-1 self-stretch"
        collapsable={false}
        onHeaderHeightChange={({ nativeEvent }) => {
          setHeight(nativeEvent.height);
          onHeightChange?.(nativeEvent.height);
        }}
        onSearchActiveChange={({ nativeEvent }) => {
          if (nativeEvent.active) {
            setHasOpenedSearch(true);
          }
          setIsSearchActive(nativeEvent.active);
          onSearchActiveChange?.(nativeEvent.active);
        }}
        onSearchPress={onSearchPress}
        onSearchValueChange={({ nativeEvent }) => {
          onSearchValueChange?.(nativeEvent.value);
        }}
        scrollViewTestID={scrollViewTestID}
        searchAccessibilityLabel={searchAccessibilityLabel}
        topInset={topInset}
      />
    </View>
  );
}
