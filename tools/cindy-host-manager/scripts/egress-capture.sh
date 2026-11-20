#!/usr/bin/env bash
# Temporary, observation-only egress record for managed Cindy CLI instances.
#
# Records, per running instance: new outbound TCP connections, UDP flows, DNS queries
# and answers, the TLS ClientHello server name (SNI), and the first request line sent to
# the instance's proxy (e.g. `CONNECT host:443`, kept to 64 payload bytes so proxy
# authentication headers are not stored). Other payload is never recorded beyond the
# first 600 bytes of those packets. It never changes firewall, routing, Docker or proxy
# configuration, and only captures traffic from managed instance IPs.
# A sampler also notes which in-container process held each remote connection.
#
#   sudo scripts/egress-capture.sh start [HOURS]   # default 24 hours, then stops itself
#   sudo scripts/egress-capture.sh status
#   sudo scripts/egress-capture.sh stop
#   sudo scripts/egress-capture.sh report [--all]
#
# Data directory: $CINDY_EGRESS_DIR (default /var/tmp/cindy-egress-capture), mode 0700.
set -euo pipefail

DIR="${CINDY_EGRESS_DIR:-/var/tmp/cindy-egress-capture}"
MAX_MB="${CINDY_EGRESS_MAX_MB:-500}"
SAMPLE_SECONDS="${CINDY_EGRESS_SAMPLE_SECONDS:-15}"
LABEL=io.cindy.host-manager
SNAPLEN=600
# Ethernet + IPv4 + TCP with timestamps = 66 bytes; leaves 64 bytes for the request line.
PROXY_SNAPLEN=130
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$HERE/$(basename "${BASH_SOURCE[0]}")"

die() { echo "error: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "run with sudo"; }
now() { date '+%Y-%m-%dT%H:%M:%S%z'; }
supervisor_pid() { [ -f "$DIR/supervisor.pid" ] && cat "$DIR/supervisor.pid" || true; }
running() { local pid; pid="$(supervisor_pid)"; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; }

# One line per instance network: "IP IFACE CONTAINER PROXY_HOST:PORT|-".
# The proxy is reduced to host:port; any user:password in the URL is never written.
instances() {
  local name proxy ip netid iface
  docker ps --filter "label=$LABEL=1" --filter "label=$LABEL.role=service" --format '{{.Names}}' | sort |
  while read -r name; do
    proxy="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$name" | sed -n 's/^HTTPS_PROXY=//p' | head -n1)"
    proxy="${proxy#*://}"; proxy="${proxy##*@}"; proxy="${proxy%%/*}"; [ -n "$proxy" ] || proxy=-
    docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.NetworkID}}{{println}}{{end}}' "$name" |
    while read -r ip netid; do
      [ -n "$ip" ] && [ -n "$netid" ] || continue
      iface="$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$netid" 2>/dev/null || true)"
      [ -n "$iface" ] || iface="br-${netid:0:12}"
      echo "$ip $iface $name $proxy"
    done
  done
}

DUMP_PIDS=()
stop_dumps() {
  local pid
  for pid in "${DUMP_PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  for pid in "${DUMP_PIDS[@]:-}"; do [ -n "$pid" ] && wait "$pid" 2>/dev/null || true; done
  DUMP_PIDS=()
}
dumps_alive() {
  local pid
  [ "${#DUMP_PIDS[@]}" -gt 0 ] || return 1
  for pid in "${DUMP_PIDS[@]}"; do kill -0 "$pid" 2>/dev/null || return 1; done
}
start_dumps() {
  local snapshot="$1" iface ips src dst filter stamp ports
  stamp="$(date '+%Y%m%dT%H%M%S')"
  ports="$(awk '$4 != "-" {n = split($4, a, ":"); print "dst port " a[n]}' <<<"$snapshot" | sort -u | paste -sd' ' | sed 's/ dst/ or dst/g')"
  for iface in $(awk '{print $2}' <<<"$snapshot" | sort -u); do
    ips="$(awk -v i="$iface" '$2 == i {print $1}' <<<"$snapshot")"
    src="$(sed 's/^/src host /' <<<"$ips" | paste -sd' ' | sed 's/ src/ or src/g')"
    dst="$(sed 's/^/dst host /' <<<"$ips" | paste -sd' ' | sed 's/ dst/ or dst/g')"
    # New TCP connections (SYN), any UDP (incl. DNS queries), TLS ClientHello (SNI), DNS answers.
    filter="(($src) and ((tcp[tcpflags] & (tcp-syn|tcp-ack)) == tcp-syn or udp or (tcp and tcp[((tcp[12:1] & 0xf0) >> 2):1] = 0x16 and tcp[((tcp[12:1] & 0xf0) >> 2)+5:1] = 0x01))) or (($dst) and udp src port 53)"
    # Ubuntu's tcpdump AppArmor profile only allows writing *.pcap; no -C rotation suffixes.
    tcpdump -i "$iface" -n -s "$SNAPLEN" -U -Z root -w "$DIR/cap-$stamp-$iface.pcap" "$filter" \
      >>"$DIR/tcpdump.log" 2>&1 &
    DUMP_PIDS+=("$!")
    [ -n "$ports" ] || continue
    # Proxy request lines: payload starting with CONN / GET / POST / HEAD / PUT.
    local start='tcp[((tcp[12:1] & 0xf0) >> 2):4]'
    filter="($src) and tcp and ($ports) and ($start = 0x434f4e4e or $start = 0x47455420 or $start = 0x504f5354 or $start = 0x48454144 or $start = 0x50555420)"
    tcpdump -i "$iface" -n -s "$PROXY_SNAPLEN" -U -Z root -w "$DIR/req-$stamp-$iface.pcap" "$filter" \
      >>"$DIR/tcpdump.log" 2>&1 &
    DUMP_PIDS+=("$!")
  done
}

# Runs inside each instance as its normal user: remote TCP/UDP sockets and their process.
PROCESS_PROBE='const fs=require("fs");const socks={};
const v4=h=>h.match(/../g).reverse().map(x=>parseInt(x,16)).join(".");const hex=h=>h.length===8?v4(h):/^0{16}FFFF0000/i.test(h)?v4(h.slice(24)):h;
for(const [f,proto] of [["/proc/net/tcp","tcp"],["/proc/net/tcp6","tcp"],["/proc/net/udp","udp"],["/proc/net/udp6","udp"]]){let text="";try{text=fs.readFileSync(f,"utf8")}catch{continue}
for(const l of text.split("\n").slice(1)){const p=l.trim().split(/\s+/);if(p.length<10)continue;const [h,port]=p[2].split(":");const ip=hex(h);
if(ip==="0.0.0.0"||ip.startsWith("127.")||/^0+$/.test(h)||/^0{24}0100{4}$/i.test(h)||(proto==="tcp"&&p[3]!=="01"))continue;socks[p[9]]=proto+" "+ip+":"+parseInt(port,16);}}
for(const pid of fs.readdirSync("/proc").filter(x=>/^\d+$/.test(x))){let cmd;try{cmd=fs.readFileSync("/proc/"+pid+"/cmdline","utf8").split("\0").filter(Boolean).slice(0,2).join(" ").replace(/\s+/g," ").slice(0,80)}catch{continue}
let fds=[];try{fds=fs.readdirSync("/proc/"+pid+"/fd")}catch{continue}
for(const fd of fds){let t;try{t=fs.readlinkSync("/proc/"+pid+"/fd/"+fd)}catch{continue}const m=/socket:\[(\d+)\]/.exec(t);if(m&&socks[m[1]])console.log(socks[m[1]]+" pid="+pid+" "+cmd)}}'

declare -A SEEN=()
sample_processes() {
  local snapshot="$1" name line
  for name in $(awk '{print $3}' <<<"$snapshot" | sort -u); do
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      if [ -z "${SEEN["$name|$line"]:-}" ]; then SEEN["$name|$line"]=1; echo "$(now) $name $line" >>"$DIR/procs.log"; fi
    done < <(timeout 10 docker exec "$name" node -e "$PROCESS_PROBE" 2>/dev/null || true)
  done
}

supervise() {
  local deadline="$1" current="" snapshot used
  trap 'stop_dumps; echo "$(now) stopped" >>"$DIR/events.log"; exit 0' TERM INT
  echo "$(now) started until $(date -d "@$deadline" '+%Y-%m-%dT%H:%M:%S%z')" >>"$DIR/events.log"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    snapshot="$(instances 2>/dev/null || true)"
    if [ "$snapshot" != "$current" ] || { [ -n "$snapshot" ] && ! dumps_alive; }; then
      stop_dumps; current="$snapshot"
      if [ -n "$snapshot" ]; then
        sed "s/^/$(now) /" <<<"$snapshot" >>"$DIR/map.log"
        start_dumps "$snapshot"
      else
        echo "$(now) no running instances" >>"$DIR/events.log"
      fi
    fi
    used="$(du -sm "$DIR" | awk '{print $1}')"
    if [ "$used" -ge "$MAX_MB" ]; then echo "$(now) size limit ${MAX_MB}MB reached" >>"$DIR/events.log"; break; fi
    [ -z "$snapshot" ] || sample_processes "$snapshot"
    sleep "$SAMPLE_SECONDS" & wait $!
  done
  stop_dumps
  echo "$(now) finished" >>"$DIR/events.log"
}

case "${1:-}" in
  start)
    need_root
    for tool in tcpdump docker python3 timeout; do command -v "$tool" >/dev/null || die "$tool is required"; done
    hours="${2:-24}"; [[ "$hours" =~ ^[0-9]+$ ]] && [ "$hours" -ge 1 ] && [ "$hours" -le 168 ] || die "HOURS must be 1-168"
    running && die "already running (pid $(supervisor_pid)); use stop first"
    install -d -m 700 "$DIR"
    [ -n "$(instances)" ] || die "no running managed instances found"
    deadline=$(( $(date +%s) + hours * 3600 ))
    nohup setsid "$SELF" _supervise "$deadline" >>"$DIR/supervisor.log" 2>&1 </dev/null &
    echo "$!" >"$DIR/supervisor.pid"
    sleep 2
    running || die "failed to start; see $DIR/supervisor.log and $DIR/tcpdump.log"
    echo "Recording for $hours hour(s) into $DIR"
    echo "Instances:"; instances | awk '{printf "  %-55s %-15s %s\n", $3, $1, $2}'
    ;;
  _supervise) supervise "$2" ;;
  stop)
    need_root
    if running; then
      kill -TERM "$(supervisor_pid)"
      for _ in $(seq 1 20); do running || break; sleep 0.5; done
      running && die "supervisor did not stop"
      echo "Stopped."
    else echo "Not running."; fi
    ;;
  status)
    need_root
    if running; then echo "Running (pid $(supervisor_pid))"; else echo "Not running"; fi
    [ -d "$DIR" ] || exit 0
    tail -n 3 "$DIR/events.log" 2>/dev/null | sed 's/^/  /'
    echo "Data: $(du -sh "$DIR" | awk '{print $1}') in $DIR"
    ls -1 "$DIR"/cap-*.pcap "$DIR"/req-*.pcap 2>/dev/null | sed 's/^/  /'
    ;;
  report)
    need_root
    shift
    exec python3 -I "$HERE/egress-report.py" "$DIR" "$@"
    ;;
  *) sed -n '2,15p' "$SELF" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
