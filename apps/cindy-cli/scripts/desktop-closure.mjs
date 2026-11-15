// Guard for the Desktop sources this CLI imports directly (fork maintenance, see
// docs/cindy-cli-client-plan.md). After merging upstream, Desktop may start importing
// Electron or other Desktop-only modules from these files; fail the build and name the
// first offending file instead of producing a CLI that crashes at runtime.

/** Desktop paths (repo-relative, forward slashes) this CLI may bundle. */
export const DESKTOP_ALLOWED = [
  /^apps\/desktop\/src\/main\/remote-agent\/(controller|executor)\/[^/]+\.ts$/,
  /^apps\/desktop\/src\/main\/remote-agent\/(credentials|managedSkillDigest|startupTiming|turnLifecycle|wire)\.ts$/,
  /^apps\/desktop\/src\/main\/localDb\/(sessionRuntimeCleanup|sessionArchiveSync)\.ts$/,
  /^apps\/desktop\/src\/main\/device-link\/linkRecovery\.ts$/,
  /^apps\/desktop\/src\/shared\/providerShareCredentialConsent\.ts$/,
];

/** Modules that only exist inside Electron. */
export const FORBIDDEN_MODULES = new Set(['electron', 'original-fs', 'electron-store']);

/**
 * @param {Record<string, { imports?: Array<{ path: string, external?: boolean }> }>} inputs esbuild metafile inputs, repo-relative (absWorkingDir = repo root)
 * @returns {string[]} human-readable violations; empty when the closure is acceptable
 */
export function desktopClosureViolations(inputs) {
  const violations = [];
  for (const [file, info] of Object.entries(inputs)) {
    const normalized = file.replaceAll('\\', '/');
    if (normalized.startsWith('apps/desktop/') && !DESKTOP_ALLOWED.some(pattern => pattern.test(normalized))) {
      violations.push(`Desktop module outside the CLI allowlist: ${normalized}`);
    }
    for (const imported of info.imports ?? []) {
      const root = imported.path.startsWith('@') ? imported.path.split('/').slice(0, 2).join('/') : imported.path.split('/')[0];
      if (FORBIDDEN_MODULES.has(root)) violations.push(`${normalized} imports ${imported.path}`);
    }
  }
  return violations;
}
