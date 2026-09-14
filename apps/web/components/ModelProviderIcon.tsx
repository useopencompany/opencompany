import {
  AnthropicIcon,
  DeepSeekIcon,
  GeminiIcon,
  type LucideIcon,
  MinimaxIcon,
  MistralIcon,
  MoonshotIcon,
  OpenAIIcon,
  XaiIcon,
  ZaiIcon,
} from "@opencompany/ui/icons";
import { Sparkles } from "lucide-react";

// Model ids are `<provider>/<model>`, so the provider prefix is the only thing an icon
// depends on. Providers without a brand mark fall back to the generic sparkle.
const PROVIDER_ICONS: Record<string, LucideIcon> = {
  anthropic: AnthropicIcon,
  deepseek: DeepSeekIcon,
  google: GeminiIcon,
  minimax: MinimaxIcon,
  mistral: MistralIcon,
  moonshotai: MoonshotIcon,
  openai: OpenAIIcon,
  xai: XaiIcon,
  zai: ZaiIcon,
};

export function ModelProviderIcon({
  modelId,
  size,
  strokeWidth,
  className,
}: {
  modelId: string;
  size: number;
  strokeWidth: number;
  className?: string;
}) {
  const Icon = PROVIDER_ICONS[modelId.split("/")[0] ?? ""] ?? Sparkles;
  return <Icon size={size} strokeWidth={strokeWidth} className={className} />;
}
