import {
  Canvas,
  LinearGradient,
  matchFont,
  type SkFont,
  Text as SkiaText,
  useClock,
  vec,
} from "@shopify/react-native-skia";
import { useMemo } from "react";
import { useDerivedValue, useReducedMotion } from "react-native-reanimated";
import { useUniwind } from "uniwind";

type FontWeight = "400" | "500" | "600" | "700" | "800";

const wrapText = (text: string, font: SkFont, maxWidth: number, maxLines: number): string[] => {
  const words = text.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (current === "" || font.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) {
        current = "";
        break;
      }
    }
  }
  if (current !== "" && lines.length < maxLines) lines.push(current);

  return lines.length > 0 ? lines : [""];
};

export function ShimmerText({
  text,
  width,
  fontSize = 16,
  fontWeight = "500",
  periodMs = 1500,
  maxLines = 1,
}: {
  text: string;
  width: number;
  fontSize?: number;
  fontWeight?: FontWeight;
  periodMs?: number;
  maxLines?: number;
}) {
  const { theme } = useUniwind();
  const reducedMotion = useReducedMotion();
  const font = useMemo(
    () => matchFont({ fontFamily: "Helvetica", fontSize, fontWeight }),
    [fontSize, fontWeight],
  );
  const { lines, lineHeight, baseline, height } = useMemo(() => {
    const metrics = font.getMetrics();
    const wrapped = wrapText(text, font, width, maxLines);
    const bounds = wrapped.map((line) => font.measureText(line));
    const ascent = Math.ceil(Math.max(-metrics.ascent, ...bounds.map((rect) => -rect.y)));
    const descent = Math.ceil(
      Math.max(metrics.descent, ...bounds.map((rect) => rect.y + rect.height)),
    );
    const computedLineHeight = ascent + descent + 2;
    return {
      lines: wrapped,
      lineHeight: computedLineHeight,
      baseline: ascent + 1,
      height: wrapped.length * computedLineHeight,
    };
  }, [font, maxLines, text, width]);
  const baseColor = theme === "dark" ? "rgba(235,235,245,0.38)" : "rgba(60,60,67,0.38)";
  const highlightColor = theme === "dark" ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.82)";
  const band = Math.max(60, width * 0.5);
  const travel = width + band * 2;
  const clock = useClock();
  const startX = useDerivedValue(() =>
    reducedMotion ? width / 2 - band / 2 : -band + ((clock.value % periodMs) / periodMs) * travel,
  );
  const gradientStart = useDerivedValue(() => vec(startX.value, 0));
  const gradientEnd = useDerivedValue(() => vec(startX.value + band, 0));

  return (
    <Canvas style={{ width, height }}>
      {lines.map((line, index) => (
        <SkiaText
          font={font}
          key={`${index}:${line}`}
          text={line}
          x={0}
          y={baseline + index * lineHeight}
        >
          <LinearGradient
            colors={[baseColor, highlightColor, baseColor]}
            end={gradientEnd}
            positions={[0, 0.5, 1]}
            start={gradientStart}
          />
        </SkiaText>
      ))}
    </Canvas>
  );
}
