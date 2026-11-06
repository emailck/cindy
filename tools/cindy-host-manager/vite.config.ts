import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
// Consume the existing design registry's generated Light/Dark defaults. No second palette.
const source = readFileSync(
  new URL("../../apps/desktop/src/renderer/themes/colors.ts", import.meta.url),
  "utf8",
);
const defaults = JSON.parse(
  source.split("const GENERATED_DEFAULTS = ")[1].split(" as const;")[0],
) as Record<string, { light: string; dark: string }>;
const theme = (mode: "light" | "dark") =>
  Object.entries(defaults)
    .map(([name, value]) => `--${name}:${value[mode]};`)
    .join("");
export default defineConfig({
  root: "web",
  plugins: [
    {
      name: "cindy-design-theme",
      resolveId(id) {
        if (id === "virtual:theme.css") return "\0virtual:theme.css";
      },
      load(id) {
        if (id === "\0virtual:theme.css")
          return `:root{${theme("light")}}:root[data-theme="dark"]{${theme("dark")}}`;
      },
    },
  ],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } } },
  test: {
    root: ".",
    include: ["src/**/*.test.ts", "web/**/*.test.ts", "web/**/*.test.tsx"],
  },
});
