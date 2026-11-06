# Cindy CLI Host Manager

A single Linux host administrator panel for multiple **cindy-host CLI** containers.
Each instance runs either Codex or Claude Code. The containers do not run Desktop,
Electron, VNC, or a desktop environment. The web page handles creation, native
account login, start/stop, invitations and sharing approvals. Desktop and Mobile
remain external Cindy clients that use the running provider.

This is an independent npm package; do not install the repository workspace just
to run this manager. Requirements: Node.js 24+, npm, a local Docker Engine with a
Unix socket, and the cindy-host runtime image. Building that image from source
requires the repository's separate pnpm setup; see [CLI deployment](../../apps/cindy-host/README.md).

## Install and start

From the repository root:

```sh
docker build -f apps/cindy-host/Dockerfile -t cindy-host:local .
cd tools/cindy-host-manager
npm ci --workspaces=false
npm run typecheck
npm test
npm run test:integration
npm run build
```

Choose a **private directory outside every Git checkout**. The manager refuses
unsafe storage locations and permissions. Keep its encryption key alongside the
SQLite database when making protected backups; losing it makes saved Proxy
credentials unreadable. Runtime account data lives in separate named Docker
volumes for each instance. Stopping or restarting does not delete these volumes.

```sh
export CINDY_MANAGER_DATA_DIR="$HOME/.local/share/cindy-host-manager"
export CINDY_MANAGER_IMAGE=cindy-host:local
npm run init
npm start
```

Run `npm run init` directly in a terminal to generate and display an administrator
password once. Store it in your password manager. For automation, the underlying
`node dist/main.js init` accepts a password on stdin (at least 12 characters); do
not place it in a repository file, command argument, or shell history. Existing
administrator initialization is not overwritten.

Open `http://127.0.0.1:8787`. The default listener is loopback only. The process
account must be able to access the Docker socket. Docker control is powerful;
only trusted administrators should have access to this page.

## Use

1. Sign in, expand **Create instance**, give it a name, and select Codex or Claude
   Code. Engine identity cannot be changed after creation.
2. Select the instance. While stopped, log in to **Cindy**, then select **Codex**
   or **Claude Code**. The output panel is read-only: typing, pasting and Ctrl+C
   do not send input to the CLI. Use its HTTPS link to authorize in your browser;
   keep the output panel open until the native process finishes. Copy selected
   output with the copy button. If the native login explicitly asks for a code or
   account choice, expand **Enter content needed for login** and submit one line
   in the separate masked form; its value is cleared immediately. For Cindy email
   login choose Email and supply the address. Closing the panel cancels active login.
3. When the native login ends, the page automatically checks the actual saved
   authentication. Exit 130 is shown as interrupted; a browser success page alone
   does not prove that the CLI saved credentials. Close the completed output panel,
   review the saved status (or use **Check saved login**), then select **Start**.
   “Container running” and “Saved” are separate facts. Neither guarantees live
   authorization, connectivity, or availability. Verify availability in your
   external Cindy client.
4. Under **Provider sharing**, refresh the running instance's actual requests and
   members. Create an invitation link and copy it to the intended recipient.
   Enter the pairing code supplied by that recipient before approving. Members
   can be paused, resumed, or removed. Links and terminal output are temporary;
   they disappear when the view is closed, changed, or signed out.

Opening an instance automatically checks its saved authentication; refresh only
checks the selected instance. Account details show the safe name/email and native
login method, with plan/organization only when provided. Missing details are
explicitly unavailable, not guessed; API Key mode never displays a key fragment.
Cindy details are a protected snapshot bound to the saved session. Older stopped
instances can fill missing details through the CLI's exclusive refresh command;
running instances rely on their current host and may need a controlled restart
after upgrading the CLI image. Native Codex identity uses its local account-session
query without refreshing remote workspace metadata or running a model.

The manager supports English and Simplified Chinese. It follows the system's
initial Light/Dark preference and offers an explicit appearance selector. It does
not claim the Desktop client's full locale coverage.

## Optional HTTP Proxy

Under Settings, enter an `http://host:port` CONNECT Proxy and optional username
and password. Each instance explicitly selects No Proxy or Use default Proxy.
Empty password retains the saved password; Clear default Proxy removes the
configuration. Credentials are encrypted on the manager host and are never
returned by the settings API. Settings apply to future starts and logins; restart
running instances to pick up changes. Keep loopback destinations direct.

The address must be HTTP; it can tunnel HTTPS destinations. HTTPS-to-Proxy
transport (`https://`), SOCKS, and forced egress for arbitrary child processes are
unsupported. A failed Proxy does not silently fall back to a direct connection.
Real account login, external provider access, and a real Proxy must be checked
in your deployment; unit tests use synthetic data.

## HTTPS reverse proxy

For access beyond the host, terminate TLS in a trusted reverse proxy, keep the
Node listener on loopback, and set the **exact external origin** before starting:

```sh
export CINDY_MANAGER_ORIGIN=https://manager.example.com
npm start
```

Example nginx server location (inside your HTTPS server):

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 15m;
}
```

Preserve Host and Origin, allow WebSocket upgrades, and do not log request bodies,
terminal traffic, or invitation responses. The browser and API must share one
origin. Sessions use HttpOnly/SameSite cookies; writes require Origin and CSRF,
and login WebSockets are bound to their creating session. Signing out cancels
that session's active login interactions. Never expose the Docker socket to the
browser or to managed containers.

Configuration: `CINDY_MANAGER_HOST` (default `127.0.0.1`),
`CINDY_MANAGER_PORT` (default `8787`), `CINDY_MANAGER_IMAGE`,
`CINDY_MANAGER_DOCKER_SOCKET` (optional local socket),
`CINDY_MANAGER_DATA_DIR`, and `CINDY_MANAGER_ORIGIN`.
Non-loopback binding requires an explicit HTTPS origin behind a TLS proxy.
Use a service supervisor with the same private data path and image configuration
for unattended operation. The manager must stay on the Docker host.

## Development and validation

`npm run build` emits `dist/main.js` and `dist/web`. Production startup needs
those files, this package's production dependencies, Node 24+, and Docker.
Frontend builds consume the repository's existing generated semantic color
registry; build from this repository checkout. No account secrets belong here.

`npm run typecheck` checks web and backend, and `npm test` runs the independent
manager unit tests. `npm run test:integration` explicitly runs HTTP/WebSocket and
SQLite tests with a synthetic runtime; it requires loopback socket access. Browser inspection, real Docker behavior, native OAuth login,
sharing from a second client, and external Proxy egress have distinct acceptance
requirements; passing mocked tests does not establish those results. Interrupted
profiles are never repaired by blindly deleting locks. Stop and inspect the
instance before recovery; do not manually remove its volumes.

For the optional Docker runtime smoke test (requires Docker and the built image):

```sh
TMPDIR=/var/tmp CINDY_MANAGER_IMAGE=cindy-host:local node --experimental-transform-types scripts/smoke-docker-runtime.mjs
```

This checks real empty CLI instances and versions, then uses an explicitly fake
overlay for terminal, cancellation, sharing and restart behavior. It cleans only
its own UUID-labelled containers, volumes and temporary fixture image. No real
accounts or external Proxy are used. Node 24's transform-types warning is expected.

Only one manager process may use a data directory (`manager.lock`). After a crash,
verify the old manager PID has stopped and any owned orphan login container has
been terminated before removing a stale manager lock. Active temporary containers
block reuse of the affected profile. Do not clear account/profile locks or remove
unknown containers as a shortcut. On a test host whose default temporary directory
is itself inside a Git workspace, use `TMPDIR=/var/tmp npm run test:integration`
to keep the synthetic SQLite database outside Git.
