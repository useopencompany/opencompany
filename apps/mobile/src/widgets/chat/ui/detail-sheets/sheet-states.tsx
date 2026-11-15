import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { until } from "until-async";
import { PressableScale } from "@/shared/ui/pressable-scale";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useToast } from "@/shared/ui/toast";

export function SheetLoading() {
  return (
    <View accessibilityLabel="Loading details" className="flex-1 items-center justify-center p-8">
      <ActivityIndicator colorClassName="accent-muted-foreground" />
    </View>
  );
}

/** Says why details are missing and, when a refresh could find them, offers one. */
export function SheetUnavailable({
  title,
  message,
  isOffline,
  isReloading,
  onReload,
}: {
  title: string;
  message: string;
  isOffline: boolean;
  isReloading: boolean;
  onReload: () => void;
}) {
  return (
    <View className="flex-1 items-center justify-center gap-3 p-8">
      <StyledSymbolView
        name={isOffline ? "wifi.slash" : "exclamationmark.bubble"}
        size={28}
        tintColorClassName="accent-muted-foreground"
      />
      <Text className="text-center text-[17px] font-semibold text-foreground">{title}</Text>
      <Text className="text-center text-[15px] leading-[21px] text-muted-foreground">
        {isOffline ? `${message} Connect to the internet to load them.` : message}
      </Text>
      {isOffline ? null : (
        <View className="flex-row justify-center self-stretch">
          <ReloadButton isReloading={isReloading} onReload={onReload} />
        </View>
      )}
    </View>
  );
}

export function ReloadButton({
  isReloading,
  onReload,
}: {
  isReloading: boolean;
  onReload: () => void;
}) {
  return (
    <PressableScale
      accessibilityLabel={isReloading ? "Loading details" : "Try again"}
      className="min-h-11 flex-row items-center justify-center gap-2 self-start rounded-full bg-secondary px-4"
      disabled={isReloading}
      onPress={onReload}
    >
      {isReloading ? (
        <ActivityIndicator size="small" colorClassName="accent-muted-foreground" />
      ) : null}
      <Text className="text-[15px] font-medium text-foreground">
        {isReloading ? "Loading" : "Try again"}
      </Text>
    </PressableScale>
  );
}

export function CopyButton({ label, text }: { label: string; text: string }) {
  const { showErrorToast } = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <PressableScale
      accessibilityLabel={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
      className="min-h-11 flex-row items-center gap-1.5 px-1"
      onPress={async () => {
        const [error] = await until(() => Clipboard.setStringAsync(text));
        if (error) {
          showErrorToast("That could not be copied.", error, "chat.detail.copy");
          return;
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setCopied(true);
      }}
    >
      <StyledSymbolView
        name={copied ? "checkmark" : "doc.on.doc"}
        size={13}
        tintColorClassName="accent-accent"
      />
      <Text className="text-[15px] text-accent">{copied ? "Copied" : "Copy"}</Text>
    </PressableScale>
  );
}
