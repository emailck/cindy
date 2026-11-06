import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let buildRevision = process.env.CINDY_HOST_BUILD_REVISION ?? 'unknown';
if (process.env.CINDY_HOST_BUILD_REVISION !== undefined) {
  if (!/^[a-f0-9]{7,40}(?:-dirty)?$/i.test(buildRevision)) throw new Error('CINDY_HOST_BUILD_REVISION must be a Git revision, optionally suffixed with -dirty.');
} else {
  try {
    const gitOptions = { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    buildRevision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], gitOptions).trim();
    if (execFileSync('git', ['status', '--porcelain'], gitOptions).trim()) buildRevision += '-dirty';
  } catch { buildRevision = 'unknown'; /* Source archives have no Git metadata. */ }
}
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
  define: { 'import.meta.url': '__cindyHostModuleUrl', __CINDY_HOST_BUILD_REVISION__: JSON.stringify(buildRevision) },
  banner: { js: '#!/usr/bin/env node\nconst __cindyHostModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
  external: ['@napi-rs/keyring', 'better-sqlite3', 'sharp'],
});
