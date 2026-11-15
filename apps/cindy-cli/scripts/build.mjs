import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { build } from 'esbuild';
import { desktopClosureViolations, FORBIDDEN_MODULES } from './desktop-closure.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '../..');
let buildRevision = process.env.CINDY_CLI_BUILD_REVISION ?? 'unknown';
if (process.env.CINDY_CLI_BUILD_REVISION !== undefined) {
  if (!/^[a-f0-9]{7,40}(?:-dirty)?$/i.test(buildRevision)) throw new Error('CINDY_CLI_BUILD_REVISION must be a Git revision, optionally suffixed with -dirty.');
} else {
  try {
    const gitOptions = { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    buildRevision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], gitOptions).trim();
    if (execFileSync('git', ['status', '--porcelain'], gitOptions).trim()) buildRevision += '-dirty';
  } catch { buildRevision = 'unknown'; /* Source archives have no Git metadata. */ }
}

// Electron-only modules become externals so the closure guard below reports who imports them.
const forbiddenAsExternal = {
  name: 'forbidden-desktop-modules',
  setup(builder) {
    builder.onResolve({ filter: /^[a-z@]/ }, args => {
      const root = args.path.startsWith('@') ? args.path.split('/').slice(0, 2).join('/') : args.path.split('/')[0];
      return FORBIDDEN_MODULES.has(root) ? { path: args.path, external: true } : undefined;
    });
  },
};

// Ink loads React DevTools only when DEV=true; bundled as ESM, its external import would be
// hoisted and executed at startup. The terminal client never ships DevTools.
const noInkDevtools = {
  name: 'no-ink-devtools',
  setup(builder) {
    builder.onResolve({ filter: /^\.\/devtools\.js$/ }, args => (/[\\/]ink[\\/]/.test(args.importer) ? { path: 'ink-devtools', namespace: 'stub' } : undefined));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export {};', loader: 'js' }));
  },
};

const result = await build({
  entryPoints: [path.join(appDir, 'src/main.ts')],
  outfile: path.join(appDir, 'dist/cindy.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  // ESM output: ink and its dependencies use top-level await.
  format: 'esm',
  sourcemap: true,
  jsx: 'automatic',
  metafile: true,
  // Metafile input paths are relative to this directory; the closure guard expects repo-relative paths.
  absWorkingDir: repoRoot,
  // Desktop sources are imported in place; their bare imports fall back to this app's dependencies.
  nodePaths: [path.join(appDir, 'node_modules'), path.resolve(appDir, '../../node_modules')],
  loader: { '.md': 'text', '.txt': 'text' },
  define: { __CINDY_CLI_BUILD_REVISION__: JSON.stringify(buildRevision), 'process.env.DEV': '"false"' },
  // Bundled CommonJS dependencies still call require/__dirname; resolve them at delivery.
  banner: { js: [
    '#!/usr/bin/env node',
    'import { createRequire as __cindyCreateRequire } from "node:module";',
    'import { fileURLToPath as __cindyFileUrlToPath } from "node:url";',
    'import { dirname as __cindyDirname } from "node:path";',
    'const require = __cindyCreateRequire(import.meta.url);',
    'const __filename = __cindyFileUrlToPath(import.meta.url);',
    'const __dirname = __cindyDirname(__filename);',
  ].join('\n') },
  external: ['@napi-rs/keyring', 'better-sqlite3', 'sharp', 'react-devtools-core'],
  plugins: [forbiddenAsExternal, noInkDevtools],
});

const inputs = Object.keys(result.metafile.inputs);
if (!inputs.some(file => file.replaceAll('\\', '/').startsWith('apps/desktop/'))) {
  // The CLI must bundle Desktop's controller; an empty match means the guard is looking at the wrong paths.
  console.error('Desktop import closure check failed: no Desktop inputs found; metafile paths are not repo-relative.');
  process.exitCode = 1;
}
// Runnable directly (./dist/cindy.mjs, symlinks) on Linux and macOS; no effect on Windows.
chmodSync(path.join(appDir, 'dist/cindy.mjs'), 0o755);
const violations = desktopClosureViolations(result.metafile.inputs);
if (violations.length > 0) {
  console.error('Desktop import closure check failed (see docs/cindy-cli-client-plan.md, upstream merge checklist):');
  for (const line of violations.slice(0, 20)) console.error(`  - ${line}`);
  process.exitCode = 1;
}
