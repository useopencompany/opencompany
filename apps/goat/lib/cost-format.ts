export function formatUsdMicros(value: number) {
  const micros = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const dollars = micros / 1_000_000;
  if (dollars === 0) return "$0.0000";
  if (dollars < 0.0001) return "<$0.0001";
  return `$${dollars.toFixed(4)}`;
}
