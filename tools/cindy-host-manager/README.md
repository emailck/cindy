# Cindy CLI Host Manager

An administrator panel for **cindy-host CLI** containers. Standalone mode manages
one Linux Docker host; optional central mode brings multiple independent
standalone managers into one page.
Each instance runs either Codex or Claude Code. The containers do not run Desktop,
Electron, VNC, or a desktop environment. The web page handles creation, native
account login, start/stop, invitations and sharing approvals. Desktop and Mobile
remain external Cindy clients that use the running provider.

This is an independent npm package; do not install the repository workspace just
to run this manager. Requirements: Node.js 24+ and npm. Standalone mode also needs
a local Docker Engine with a Unix socket and the cindy-host runtime image. Building that image from source
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
and password. Each instance selects No Proxy, Use default Proxy, or Custom Proxy.
Custom Proxy has its own address and optional authentication, independent of the
global default and other instances. Stop an instance before changing its Proxy.
Existing instances keep their current selection after upgrading.

Blank username/password fields preserve saved authentication when the address is
unchanged; Clear saved authentication removes both. Changing the address does not
carry old credentials to the new Proxy. Clear default Proxy removes the global
configuration. Credentials use the existing encrypted manager store and are never
returned by the API. Custom configuration and its instance selection are saved in
one transaction, without changing the existing database schema or account volumes.
Settings apply to future starts and logins; restart running instances to pick up
changes. Selecting an unconfigured default fails explicitly. Keep loopback destinations direct.

Test Proxy checks the currently entered configuration without saving it. A temporary
container on the same Docker bridge as the instances queries `https://ipwho.is/`
through HTTP CONNECT and displays the exit IP and estimated country, region and
city. The test has no account/profile mounts, verifies TLS, follows no redirects,
and does not retry directly if the Proxy fails. The external service sees the Proxy
exit IP; an IP location estimate is not proof of the machine's physical location.
The temporary container is removed after the test, including on failure.

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
for unattended operation. Each standalone manager stays on its Docker host. A central manager does not
require Docker; it routes management operations to the selected standalone manager.

## Central management of independent machines

Each machine keeps its existing standalone manager, administrator password,
instances, Proxy settings, native account credentials and Docker volumes. Local
and central controls use that machine's same service and instance locks. The
central manager stores machine registration and credential verification data;
it does not take ownership of remote instance databases or native accounts.
Instances keep running if the central manager is unavailable, and local pages
remain usable. There is no instance migration, scheduling or automatic failover.

Build the same package for both roles. On the central host, choose a **separate
private data directory**, initialize its administrator with `npm run init`, then
start with `CINDY_MANAGER_MODE=central`. Set `CINDY_MANAGER_ORIGIN` to the exact
HTTPS origin using the reverse proxy instructions above. Central mode needs
Node.js and this package, but no Docker daemon or CLI image. The default mode
remains `standalone`; existing standalone installations do not change roles.

Sign in to the central page and add a machine. It displays a short-lived,
one-time enrollment code. On that machine, stop only the standalone **manager
process**, leaving its CLI containers and volumes intact. Complete any active
native login first. Use its existing private data directory and service account,
then enroll with the following Bash example:

```bash
export CINDY_MANAGER_MODE=standalone
export CINDY_MANAGER_CENTRAL_ORIGIN=https://manager.example.com
# CINDY_MANAGER_DATA_DIR must be the standalone manager's existing private directory.
read -r -s -p 'Enrollment code: ' cindy_enrollment
printf '\n'
printf '%s' "$cindy_enrollment" | node dist/main.js connect
unset cindy_enrollment
```

The code is read through stdin, not a command argument or shell-history literal.
Restart the standalone manager normally (`node dist/main.js serve` or its existing
service supervisor). It connects outbound to the central manager over WSS;
no inbound Docker or management port needs to be exposed on the machine.
The connection configuration and machine credential are encrypted with the
standalone manager's existing private store. The central origin above is an
example, not a provided public service.

The central page lists machines and their instances. Select a machine to use its
existing instance, account login, sharing and Proxy controls. Proxy tests run on
the selected machine. Selecting another machine clears the previous machine's
login output and sensitive UI state. Machine and overview status are refreshed
periodically while the central page is open and when it regains focus.

Only explicit manager operations are forwarded. Browser sessions stay on the
central host; they are not used as machine credentials. Login output and explicit
single-line answers are forwarded live and are not written into the federation
operation journal. A central sign-out or expired login lease cancels its remote
login interactions, not other local interactions or running CLI instances.

An offline machine is not a stopped instance. Central operations are unavailable
until it reconnects. A lost connection during a write can leave its outcome
unknown: check the machine's actual state before issuing a new operation. The
connection does not automatically replay writes; duplicate operation IDs are
rejected or resolved without executing the mutation again. Native authentication
and invitation responses are not persisted centrally for replay.

To remove central access, revoke the machine in the central page, or stop its
standalone manager process and run `node dist/main.js disconnect` with the same
service account and private data directory, then restart it. This preserves local
accounts, configuration, containers and volumes. Central revocation prevents
future connections; it does not mean that remote containers have been stopped.

Federation uses a separate versioned management protocol; incompatible peers
cannot manage each other. It does not change Cindy Device Link or its relay.
Older standalone data remains usable without a federation configuration. Rollback
of a standalone installation retains its original instance database and volumes;
older binaries ignore the extra metadata. A central data directory is not a
replacement for any standalone machine's data directory or its backups.

Implementation and acceptance scope: [plan](../../docs/cindy-manager-federation-plan.md)
and [progress](../../docs/cindy-manager-federation-progress.md).

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
