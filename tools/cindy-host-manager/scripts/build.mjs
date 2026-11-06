import { build as bundle } from "esbuild";
import { build as web } from "vite";
await bundle({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
});
await web();
