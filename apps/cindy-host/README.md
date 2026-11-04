# Cindy host

Node 22.19+ foreground host for a Cindy remote Agent provider. This app is separate
from the evaluation-only `cindy-headless`; it does not launch Electron or use Docker.
The implementation plan and current acceptance evidence live in
[the CLI plan](../../docs/cindy-cli-plan.md).

## Build and inspect

From the repository root after installing workspace dependencies:

```sh
pnpm --filter @cindy/host build
node apps/cindy-host/dist/cli.cjs help
node apps/cindy-host/dist/cli.cjs --version
```

All commands that open a profile require an explicit **absolute directory outside
Git workspaces**, through `--data-dir` or `CINDY_HOST_DATA_DIR`. Never point it at a
checkout, even an ignored subdirectory. Commands do not default to the current
working directory. Example with an operator-selected directory on Linux:

```sh
node apps/cindy-host/dist/cli.cjs --data-dir /var/lib/cindy-host status
node apps/cindy-host/dist/cli.cjs --data-dir /var/lib/cindy-host doctor
node apps/cindy-host/dist/cli.cjs --data-dir /var/lib/cindy-host config show
node apps/cindy-host/dist/cli.cjs --data-dir /var/lib/cindy-host config set remoteAccessEnabled true
node apps/cindy-host/dist/cli.cjs --data-dir /var/lib/cindy-host serve
```

On Windows pass an absolute path such as `D:\CindyHostData`, outside the source
checkout. The process must have permission to read and write the selected directory.
Stop the service with Ctrl+C or SIGTERM; cleanup also runs on failed startup.
Cancellation aborts prompts and browser polling. An already-sent credential refresh
must finish and save its rotated result before the profile lock is released;
shutdown can therefore wait on an unresponsive authentication service. Force
termination can lose an in-flight credential rotation and require signing in again.

## Sign in and configure Claude Code

Cindy authentication and Claude authentication are separate. Cindy uses the
official authentication APIs; supported methods are discovered from the service.
Verification codes and account choices are entered in a trusted interactive
terminal, with input hidden. Examples:

```sh
node apps/cindy-host/dist/cli.cjs --data-dir /var/lib/cindy-host login --email you@example.com
node apps/cindy-host/dist/cli.cjs --data-dir /var/lib/cindy-host login --social github
node apps/cindy-host/dist/cli.cjs --data-dir /var/lib/cindy-host login --org your-organization
node apps/cindy-host/dist/cli.cjs --data-dir /var/lib/cindy-host logout
```

Browser methods print a short-lived sign-in URL to open on your own computer and
poll the official result. The configured realm is used; organization discovery
does not automatically switch realms. CAPTCHA-required code login fails explicitly
and requires an available browser sign-in method.

The native `@napi-rs/keyring` dependency must be installed alongside the built
entry. Credentials use macOS Keychain, Windows Credential Manager or Linux Secret
Service. Linux requires an installed, unlocked Secret Service provider and its
user D-Bus session. There is no plaintext or temporary kernel-keyring fallback.
`doctor` reports setup failures without showing credential values.

Install and authenticate an unmodified Claude Code executable using its own
instructions. Select the executable and authentication mode in the host's process
environment (Linux shell example):

```sh
export CINDY_HOST_CLAUDE_BINARY=/absolute/path/to/claude
export CINDY_HOST_CLAUDE_AUTH=native
```

Windows requires the native executable rather than a `.cmd` wrapper. Native mode
checks `claude auth status --json`; Cindy does not read or copy Claude subscription
credentials. For API usage, choose `CINDY_HOST_CLAUDE_AUTH=api-key` and supply
`ANTHROPIC_API_KEY` through your trusted process/service secret manager. An optional
`ANTHROPIC_BASE_URL` applies to API mode. Do not place secrets in command arguments,
shell history, repository files or `config.json`.

## Configuration and authorization

`config.json` stores only explicit nonsecret overrides. `config reset <key>` removes
the override, so future defaults apply. Unsupported keys, malformed JSON and links
are rejected; a malformed original file is preserved. Edits use a lock and atomic
replacement. Restart `serve` after changing settings.

| Key | Default | Meaning |
| --- | --- | --- |
| `remoteAccessEnabled` | `false` | Explicitly allow authenticated remote provider requests |
| `permissionMode` | `full-access` | Fallback only when the desktop omits its permission mode; explicit desktop permissions take precedence. Peer/account/session checks still apply. |
| `deviceName` | OS hostname | Device name advertised by the installed runtime |

Region is the build identity (`global`), not a runtime selector. The checked-in
`config/endpoint.global.json` is bundled as the endpoint source. Authentication
tokens, passwords and provider secrets must never be placed in `config.json`, CLI
arguments, logs, or the source repository; the authentication adapter uses a
protected credential store. No desktop encrypted credential file is imported.

`serve`, authentication commands and configuration edits take the same profile
lock to prevent overlapping token rotation and profile changes. A second process
fails with `PROFILE_BUSY`. If a crash leaves `profile.lock`, verify that the old
process has exited before removing that lock. A lock is not proof of a live relay;
`status` must report the installed runtime's actual evidence.

## Integration contract and limits

`src/cli.ts` exports `runCli(argv, dependencies)` without startup side effects.
Runtime creation, safe status/diagnostics and interactive authentication are
injected. A cancellation signal covers initialization and login while the profile
lock is held. `src/lifecycle.ts` owns signal-driven shutdown; runtime startup must honor
its abort signal, and cleanup must be idempotent. A runtime may expose
`waitUntilStopped()` to report fatal background failures.

When composed without a runtime or protected authentication adapter, commands fail with
`RUNTIME_UNAVAILABLE` / `AUTH_UNAVAILABLE`; `doctor` exits nonzero. They do not claim
the machine is providing Agents. The executable wires the relay runtime and native
credential store. First-phase acceptance still requires real same-account
desktop discovery and Claude Code execution with tools returning to the desktop.
Cross-account sharing, provider groups, all Harnesses, SSH workspaces and direct
WebRTC connectivity are not implied by this scaffold.

```sh
pnpm --filter @cindy/host typecheck
pnpm --filter @cindy/host test
```
