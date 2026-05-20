import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#f7f7f5",
        sidebar: "#f1f1ef",
        border: "#e6e6e3",
        ink: {
          DEFAULT: "#111111",
          muted: "#6b6b6b",
          subtle: "#9a9a96",
        },
        pill: {
          green: "#e9f5ec",
          greenText: "#1f7a3a",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "Segoe UI",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
} satisfies Config;
