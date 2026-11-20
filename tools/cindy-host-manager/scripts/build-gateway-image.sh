#!/usr/bin/env bash
# Build the network gateway image (forced-egress "Networks") from local static binaries.
#
#   scripts/build-gateway-image.sh /path/to/mihomo [/path/to/static/busybox]
#
# mihomo and busybox must be statically linked; busybox provides `sh` and `ip` for the
# gateway entrypoint. Tags cindy-egress-gateway:local (the manager default) and
# cindy-egress-gateway:mihomo-<version>. After rebuilding, each network's gateway is
# replaced automatically the next time the network is saved or one of its instances starts.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
MIHOMO="${1:-${MIHOMO_BIN:-}}"
BUSYBOX="${2:-${BUSYBOX_BIN:-/bin/busybox}}"
TAG="${CINDY_GATEWAY_TAG:-cindy-egress-gateway:local}"
[ -n "$MIHOMO" ] || die "usage: $0 /path/to/mihomo [/path/to/static/busybox]"
command -v docker >/dev/null || die "docker is required"
for bin in "$MIHOMO" "$BUSYBOX"; do
  [ -f "$bin" ] && [ -x "$bin" ] || die "$bin is not an executable file"
  if ldd "$bin" >/dev/null 2>&1; then die "$bin must be statically linked"; fi
done
"$BUSYBOX" --list | grep -qx ip || die "$BUSYBOX has no 'ip' applet"
version="$("$MIHOMO" -v 2>/dev/null | awk 'NR == 1 { print $3 }')"
[[ "$version" =~ ^v[0-9]+(\.[0-9]+)+$ ]] || die "could not read the mihomo version"

context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
cp "$MIHOMO" "$context/mihomo"
cp "$BUSYBOX" "$context/busybox"
cat >"$context/Dockerfile" <<'DOCKERFILE'
FROM scratch
COPY mihomo /usr/bin/mihomo
COPY busybox /bin/busybox
LABEL io.cindy.host-manager.role=egress-gateway-image
ENTRYPOINT ["/usr/bin/mihomo"]
DOCKERFILE
docker build -q -t "$TAG" -t "cindy-egress-gateway:mihomo-${version#v}" "$context" >/dev/null
echo "Built $TAG and cindy-egress-gateway:mihomo-${version#v} (mihomo $version)."
