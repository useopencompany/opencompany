import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Reanimated, {
  Easing,
  interpolate,
  type SharedValue,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useReducedTransparency } from "@/shared/lib/use-reduced-transparency";
import { StyledGlassView } from "@/shared/ui/styled-glass-view";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import type { QuickActionItem } from "../model/quick-actions/quick-action-catalog";
import { tintColor } from "../model/quick-actions/quick-action-symbols";
import { COMPOSER_HORIZONTAL_MARGIN } from "./ChatComposer";

const ROW_HEIGHT = 52;
const LIST_PADDING = 6;
const HEADER_HEIGHT = 34;
// Four and a half rows: the half row tells the list scrolls.
const MAX_VISIBLE_ROWS = 4.5;
// Rows keep their 52pt height, so text stops growing before it would clip.
const MAX_FONT_SCALE = 1.4;
const OPEN_TIMING = { duration: 220, easing: Easing.bezier(0.22, 1, 0.36, 1) };
const CLOSE_TIMING = { duration: 160, easing: Easing.bezier(0.64, 0, 0.78, 0) };
const REDUCED_TIMING = { duration: 120 };
const RESIZE_TIMING = { duration: 180, easing: Easing.bezier(0.22, 1, 0.36, 1) };
const SLIDE_DISTANCE = 10;

interface MenuContent {
  header: string | null;
  items: QuickActionItem[];
  error: string | null;
}

/**
 * The `@`, `/`, and `#` menu. It floats above the composer without taking layout space, so the
 * transcript never moves, rises from the bottom as it fades in, and sinks back as it fades out.
 */
export function QuickActionMenu({
  bottom,
  error,
  header,
  items,
  maxHeight,
  onPick,
  onRetry,
  open,
}: {
  bottom: number;
  error: string | null;
  header: string | null;
  items: QuickActionItem[];
  /** The space between the navigation bar and the composer. The menu shrinks to fit it. */
  maxHeight: number;
  onPick: (item: QuickActionItem) => void;
  onRetry: () => void;
  open: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const reducedTransparency = useReducedTransparency();
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  // While the menu closes its trigger is already gone, so it keeps showing the rows it had.
  const [closingContent, setClosingContent] = useState<MenuContent>({ header, items, error });
  useLayoutEffect(() => {
    if (open) setClosingContent({ header, items, error });
  }, [open, header, items, error]);
  const content = open ? { header, items, error } : closingContent;
  // Glass mounts clear and turns to glass on the next frame, so UIKit animates it in.
  const [glassShown, setGlassShown] = useState(false);
  useEffect(() => {
    setGlassShown(open && mounted);
  }, [open, mounted]);

  const rowCount = content.items.length + (content.error ? 1 : 0);
  const headerHeight = content.header ? HEADER_HEIGHT : 0;
  const height = Math.max(
    0,
    Math.min(
      maxHeight,
      headerHeight + Math.min(rowCount, MAX_VISIBLE_ROWS) * ROW_HEIGHT + LIST_PADDING * 2,
    ),
  );

  const progress = useSharedValue(0);
  const menuHeight = useSharedValue(height);
  const scrollY = useSharedValue(0);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!mounted) return;
    if (open) {
      progress.set(withTiming(1, reducedMotion ? REDUCED_TIMING : OPEN_TIMING));
      return;
    }
    wasOpenRef.current = false;
    progress.set(
      withTiming(0, reducedMotion ? REDUCED_TIMING : CLOSE_TIMING, (finished) => {
        if (finished) scheduleOnRN(setMounted, false);
      }),
    );
  }, [open, mounted, reducedMotion]);

  // Matches change the height while the menu stays anchored at its bottom, so it grows and
  // shrinks from the top. Opening takes the height at once.
  useEffect(() => {
    if (!open) return;
    // A reopened menu mounts a new list scrolled to the top.
    if (!wasOpenRef.current) scrollY.set(0);
    menuHeight.set(
      wasOpenRef.current && !reducedMotion ? withTiming(height, RESIZE_TIMING) : height,
    );
    wasOpenRef.current = true;
  }, [open, height, reducedMotion]);

  const shellStyle = useAnimatedStyle(() => ({
    height: menuHeight.get(),
    transform: [{ translateY: reducedMotion ? 0 : (1 - progress.get()) * SLIDE_DISTANCE }],
  }));
  const contentStyle = useAnimatedStyle(() => ({ opacity: progress.get() }));
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.set(event.contentOffset.y);
  });

  if (!mounted) return null;

  const body = (
    <Reanimated.View className="flex-1" style={contentStyle}>
      {content.header ? (
        <Text
          className="px-5 pt-3 text-[13px] text-muted-foreground"
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          numberOfLines={1}
          style={{ height: HEADER_HEIGHT }}
        >
          {content.header}
        </Text>
      ) : null}
      <Reanimated.ScrollView
        accessibilityRole="list"
        contentContainerStyle={{ padding: LIST_PADDING }}
        keyboardShouldPersistTaps="always"
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
      >
        {content.items.map((item, index) => (
          <QuickActionRow
            headerHeight={headerHeight}
            highlighted={index === 0}
            index={index}
            item={item}
            key={item.key}
            menuHeight={menuHeight}
            onPress={() => onPick(item)}
            scrollY={scrollY}
          />
        ))}
        {content.error ? (
          <Pressable
            accessibilityRole="button"
            className="flex-row items-center gap-3 rounded-[20px] px-3 active:bg-foreground/10"
            onPress={onRetry}
            style={{ height: ROW_HEIGHT }}
          >
            <View className="size-7 items-center justify-center">
              <StyledSymbolView
                name="arrow.clockwise"
                size={18}
                tintColorClassName="accent-muted-foreground"
                weight="medium"
              />
            </View>
            <Text
              className="flex-1 text-[15px] text-muted-foreground"
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              numberOfLines={2}
            >
              {content.error}
            </Text>
          </Pressable>
        ) : null}
      </Reanimated.ScrollView>
    </Reanimated.View>
  );

  return (
    <Reanimated.View
      className="absolute"
      pointerEvents={open ? "box-none" : "none"}
      style={[
        { bottom, left: COMPOSER_HORIZONTAL_MARGIN, right: COMPOSER_HORIZONTAL_MARGIN },
        shellStyle,
      ]}
    >
      {reducedTransparency ? (
        <View className="flex-1 overflow-hidden rounded-[26px] border border-border border-continuous bg-card">
          {body}
        </View>
      ) : (
        <StyledGlassView
          className="flex-1 overflow-hidden rounded-[26px] border-continuous"
          glassEffectStyle={{
            style: glassShown ? "regular" : "none",
            animate: !reducedMotion,
            animationDuration: open ? 0.22 : 0.16,
          }}
        >
          {body}
        </StyledGlassView>
      )}
    </Reanimated.View>
  );
}

function QuickActionRow({
  headerHeight,
  highlighted,
  index,
  item,
  menuHeight,
  onPress,
  scrollY,
}: {
  headerHeight: number;
  highlighted: boolean;
  index: number;
  item: QuickActionItem;
  menuHeight: SharedValue<number>;
  onPress: () => void;
  scrollY: SharedValue<number>;
}) {
  // The row the bottom edge cuts through fades with how much of it shows, so the list reads as
  // continuing below without a gradient mask.
  const fadeStyle = useAnimatedStyle(() => {
    const top = LIST_PADDING + index * ROW_HEIGHT - scrollY.get();
    const shown = (menuHeight.get() - headerHeight - top) / ROW_HEIGHT;
    return { opacity: interpolate(shown, [0, 0.999, 1], [0.15, 0.55, 1], "clamp") };
  });
  const { token } = item;
  return (
    <Reanimated.View style={fadeStyle}>
      <Pressable
        accessibilityLabel={`${item.label}, ${item.tag}`}
        accessibilityRole="button"
        className={
          highlighted
            ? "flex-row items-center gap-3 rounded-[20px] bg-foreground/5 px-3 active:bg-foreground/10 dark:bg-foreground/10"
            : "flex-row items-center gap-3 rounded-[20px] px-3 active:bg-foreground/10"
        }
        onPress={onPress}
        style={{ height: ROW_HEIGHT }}
      >
        <View className="size-7 items-center justify-center">
          {token.tint ? (
            <StyledSymbolView
              name={token.symbol}
              size={20}
              tintColor={tintColor(token.tint)}
              type="hierarchical"
            />
          ) : (
            <StyledSymbolView
              name={token.symbol}
              size={20}
              tintColorClassName="accent-foreground"
              type="hierarchical"
            />
          )}
        </View>
        <Text
          className={
            item.dimmed
              ? "flex-1 text-[17px] text-muted-foreground"
              : "flex-1 text-[17px] text-foreground"
          }
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          numberOfLines={1}
        >
          {item.label}
        </Text>
        <Text
          className="text-[15px] text-muted-foreground"
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          numberOfLines={1}
        >
          {item.tag}
        </Text>
      </Pressable>
    </Reanimated.View>
  );
}
