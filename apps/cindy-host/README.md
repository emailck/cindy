# Cindy host

Node 22.19+ foreground host for a Cindy remote Agent provider. This app is separate
from the evaluation-only `cindy-headless`; it does not launch Electron or use Docker.
The implementation plan and current acceptance evidence live in
[the CLI plan](../../docs/cindy-cli-plan.md).

For Ubuntu VPS deployment, see [Linux 部署指南（中文）](DEPLOY.linux.zh-CN.md).

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
node apps/cindy-host/dist/cli.cjs --data-dir /var/lib/cindy-host login --social google
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
user D-Bus session. There is no automatic plaintext or temporary kernel-keyring fallback. Explicit file mode is described below.
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

## Codex provider

Select one harness per host process. The default `CINDY_HOST_AGENT=claude-code`
keeps existing deployments unchanged. `codex` uses the same-account remote host
and the native Codex execution-environment tunnel; project commands/files stay
on the requesting desktop. No new Device Link channel or relay protocol is used.
Selecting a harness alone does not authorize other accounts. For native Responses API
sharing, use the explicit link and approval commands described below.

```sh
export CINDY_HOST_AGENT=codex
export CINDY_HOST_CODEX_BINARY=/absolute/path/to/codex
"$CINDY_HOST_CODEX_BINARY" login --device-auth
cindy-host config set remoteAccessEnabled true
cindy-host doctor
cindy-host serve
```

Use the repository-pinned native binary, e.g.
`apps/codex-package-bin/linux-x64/bin/codex` with an absolute checkout prefix.
Codex accepts native ChatGPT or API-key login. Existing native `config.toml`
provider settings (including a Responses-compatible relay) and inherited credential
environment are preserved. Use the same HOME/CODEX_HOME and environment as your
working Codex CLI; verify that this executable reports success for `login status`.
For an existing API setup, skip `login --device-auth`; do not replace it with ChatGPT login. Native Codex owns its credentials and refresh, using
the process's normal HOME/CODEX_HOME. Cindy does not copy them into its own store; sharing reads access tokens in memory as described below.
Remote provider IDs are used for discovery and admission only; native session start,
fork and model changes do not inject them as credential routes, so concurrent
sessions retain the same native configuration.
Models and reasoning levels come from Codex `model/list`; no static fallback
models are advertised. `doctor` disposes its probe app-server; shutdown disposes
the runtime app-server after closing hosted sessions. Keep these environment
variables when restarting, or unset CINDY_HOST_AGENT to return to Claude.

Validation covers fake-relay discovery, admission, session/tunnel wiring, explicit
permission preservation and cleanup for both harnesses. Manual Windows Desktop to
Linux Codex API invocation has also been exercised, including native relay configuration.
This does not establish parity for every desktop feature: session-list/subscription
endpoints remain unsupported, and initial payload upload can still be slow.

## Share a native provider

Keep `serve` running, then use a second shell with the same data directory:

```sh
cindy-host share link
cindy-host share list
cindy-host share approve REQUEST_ID PAIRING_CODE
cindy-host share reject REQUEST_ID
cindy-host share pause MEMBER_ID
cindy-host share resume MEMBER_ID
cindy-host share remove MEMBER_ID
```

The five-minute single-use invitation is returned only to the management terminal.
The recipient applies in Desktop Cindy; the service announces the verified identity
and request ID. Read the pairing code with `share list` in the private management
terminal and check it with the recipient before approving.
Management uses a private local Unix socket and the running process's authentication;
it does not open a public control port or require another sign-in.

This adapter shares the configured Codex Responses API route, including native
`http_headers` and `env_http_headers`. Real credentials stay inside the host proxy.
Each guest engine uses the existing core guest isolation and is disposed on close;
the owner engine remains separate. Account/member/model checks apply before egress.
The Desktop membership-generation and usage ledger is reused, including cleanup
before a deleted/reapproved member can resume. `share list` includes usage totals.

CLI sharing supports native Codex Responses API providers, native ChatGPT login,
and native Claude subscription login. Claude stays inside the unmodified CLI and
uses its own credential store; Cindy never reads or proxies its subscription tokens.
ChatGPT guests use isolated ephemeral authentication and a session-bound loopback
route. The host reads access tokens from native `CODEX_HOME/auth.json` in memory;
native Codex performs refresh. Keyring-only Codex credentials are not supported by
this adapter. Changing the ChatGPT account requires restarting the host. No credential
file is copied into a guest home. Provider groups and re-sharing remain unsupported. Keep `keyring` or explicit `file` storage as appropriate.
For Docker build, initialization, persistent volumes and `docker exec` approval,
see [Docker 部署与审批](DOCKER.zh-CN.md).

## Headless Linux without a keyring

Explicitly choose private local files when OS keyring encryption is not required:

```sh
export CINDY_HOST_CREDENTIAL_STORE=file
export CINDY_HOST_DATA_DIR="$HOME/.local/share/cindy-host"
cindy-host login --social google
cindy-host status
```

Keep the same variables for login, status, doctor, logout and serve. `file` stores
unencrypted credentials in `credentials/` under the selected data directory, with
POSIX directory permissions 700 and file permissions 600. Only the owning user
(and privileged administrators) can read them. Windows file mode is unsupported.
Unsafe permissions, links and malformed records fail without replacing the record.
Writes use a private temporary file and atomic rename; logout deletes its auth record.

The default remains `keyring`; invalid values are rejected, and a keyring failure
never falls back to files. Unset the variable to restore the default. Switching
stores does not migrate or delete the other store's credentials: sign in again in
the selected store. Log out of each store separately when revoking both logins.
File mode requires neither D-Bus nor a keyring password. Status reports saved
credential presence, not a verified live connection.

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
credential store. Live acceptance still requires real same-account desktop discovery and execution
with tools returning to the desktop for each selected harness.
Direct cross-account sharing is available for native Codex Responses API, ChatGPT
login, and native Claude subscription login. Provider groups, re-sharing, other sharing adapters, SSH workspaces and
direct WebRTC connectivity are not implied by this host.

```sh
pnpm --filter @cindy/host typecheck
pnpm --filter @cindy/host test
```
