import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";

/** An inset group of rows on the glass sheet, with an optional heading and footnote. */
export function SheetSection({
  children,
  footer,
  title,
}: {
  children: ReactNode;
  footer?: ReactNode;
  title?: string;
}) {
  return (
    <View className="gap-1.5">
      {title ? (
        <Text className="px-4 font-medium text-[13px] text-muted-foreground uppercase tracking-[0.2px]">
          {title}
        </Text>
      ) : null}
      <View className="overflow-hidden rounded-[22px] border-continuous bg-foreground/5 dark:bg-foreground/10">
        {children}
      </View>
      {footer ? (
        <Text className="px-4 text-[13px] text-muted-foreground leading-[18px]">{footer}</Text>
      ) : null}
    </View>
  );
}

export function SheetRowSeparator() {
  return <View className="ml-4 h-px bg-foreground/10" />;
}

/**
 * One tappable row. `accessory` is a checkmark for a choice, a chevron for a nested screen, or
 * nothing. A disabled row stays readable so a locked value can still be seen.
 */
export function SheetRow({
  accessibilityHint,
  accessibilityLabel,
  accessory = "none",
  detail,
  disabled = false,
  leading,
  onPress,
  selected = false,
  subtitle,
  title,
  trailing,
}: {
  accessibilityHint?: string;
  accessibilityLabel?: string;
  accessory?: "check" | "chevron" | "none";
  detail?: string;
  disabled?: boolean;
  leading?: ReactNode;
  onPress?: () => void;
  selected?: boolean;
  subtitle?: ReactNode;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      className={
        disabled
          ? "min-h-[52px] flex-row items-center gap-3 px-4 py-2.5"
          : "min-h-[52px] flex-row items-center gap-3 px-4 py-2.5 active:bg-foreground/10"
      }
      disabled={disabled || !onPress}
      onPress={onPress}
    >
      {leading ? (
        <View
          className={
            disabled
              ? "size-7 items-center justify-center opacity-50"
              : "size-7 items-center justify-center"
          }
        >
          {leading}
        </View>
      ) : null}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text
          className={
            disabled
              ? "font-medium text-[17px] text-muted-foreground"
              : "font-medium text-[17px] text-foreground"
          }
          numberOfLines={1}
        >
          {title}
        </Text>
        {typeof subtitle === "string" ? (
          <Text className="text-[14px] text-muted-foreground leading-[19px]" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : (
          subtitle
        )}
      </View>
      {detail ? (
        <Text className="max-w-[55%] shrink text-[17px] text-muted-foreground" numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
      {trailing}
      {accessory === "check" && selected ? (
        <StyledSymbolView
          name="checkmark"
          size={17}
          tintColorClassName="accent-accent"
          weight="semibold"
        />
      ) : null}
      {accessory === "chevron" && !disabled ? (
        <StyledSymbolView
          name="chevron.right"
          size={14}
          tintColorClassName="accent-muted-foreground"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}
