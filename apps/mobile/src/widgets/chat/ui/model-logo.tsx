import { useUniwind } from "uniwind";
import anthropicDark from "@/assets/images/model-anthropic-dark.png";
import anthropicLight from "@/assets/images/model-anthropic-light.png";
import deepseekDark from "@/assets/images/model-deepseek-dark.png";
import deepseekLight from "@/assets/images/model-deepseek-light.png";
import moonshotDark from "@/assets/images/model-moonshot-dark.png";
import moonshotLight from "@/assets/images/model-moonshot-light.png";
import openaiDark from "@/assets/images/model-openai-dark.png";
import openaiLight from "@/assets/images/model-openai-light.png";
import qwenDark from "@/assets/images/model-qwen-dark.png";
import qwenLight from "@/assets/images/model-qwen-light.png";
import zaiDark from "@/assets/images/model-zai-dark.png";
import zaiLight from "@/assets/images/model-zai-light.png";
import { StyledImage } from "@/shared/ui/styled-image";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { AUTO_MODEL_ID } from "../model/composer-selection";

const PROVIDER_LOGOS = {
  anthropic: { light: anthropicLight, dark: anthropicDark },
  openai: { light: openaiLight, dark: openaiDark },
  alibaba: { light: qwenLight, dark: qwenDark },
  deepseek: { light: deepseekLight, dark: deepseekDark },
  moonshotai: { light: moonshotLight, dark: moonshotDark },
  zai: { light: zaiLight, dark: zaiDark },
} as const;

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  alibaba: "Alibaba",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot",
  zai: "Z.ai",
  xai: "xAI",
  google: "Google",
  mistral: "Mistral",
  minimax: "MiniMax",
};

const providerOf = (modelId: string): string => modelId.split("/")[0] ?? "";

export const modelProviderName = (modelId: string): string =>
  modelId === AUTO_MODEL_ID ? "opencompany" : (PROVIDER_NAMES[providerOf(modelId)] ?? "");

/** The provider mark for a model. Auto and providers without a bundled mark use a symbol. */
export function ModelLogo({ modelId, size }: { modelId: string; size: number }) {
  const { theme } = useUniwind();
  const logo = PROVIDER_LOGOS[providerOf(modelId) as keyof typeof PROVIDER_LOGOS];
  if (!logo)
    return (
      <StyledSymbolView
        name={modelId === AUTO_MODEL_ID ? "sparkles" : "cpu"}
        size={size * 0.85}
        style={{ width: size, height: size }}
        tintColorClassName="accent-muted-foreground"
        weight="medium"
      />
    );
  return (
    <StyledImage
      accessibilityIgnoresInvertColors
      className="opacity-70"
      contentFit="contain"
      source={theme === "dark" ? logo.dark : logo.light}
      style={{ width: size, height: size }}
    />
  );
}
