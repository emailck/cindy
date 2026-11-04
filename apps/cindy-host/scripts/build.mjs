import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [path.join(appDir, 'src/main.ts')],
  outfile: path.join(appDir, 'dist/cli.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  loader: { '.md': 'text', '.txt': 'text' },
  // Bundled ESM code may use createRequire(import.meta.url). Resolve at delivery,
  // never to the build checkout or the caller's working directory.
  define: { 'import.meta.url': '__cindyHostModuleUrl' },
  banner: { js: '#!/usr/bin/env node\nconst __cindyHostModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
  external: ['@napi-rs/keyring', 'better-sqlite3', 'sharp'],
});
