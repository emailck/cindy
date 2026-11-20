"""Summarize an egress-capture.sh recording. Standard library only; run with `python3 -I`.

Usage: egress-report.py DATA_DIR [--all]

Classifies every outbound connection from a managed instance as: via the instance's
proxy, direct (not via proxy), DNS, or local network. Names come from the instance's own
DNS answers and TLS SNI; processes come from the in-container socket sampler.
"""
import bisect
import collections
import datetime
import glob
import ipaddress
import os
import struct
import sys

CINDY_SUFFIXES = ("cindy.app", "cindy.com.cn")


def fmt_time(ts):
    return datetime.datetime.fromtimestamp(ts).strftime("%m-%d %H:%M:%S")


def parse_time(text):
    return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%S%z").timestamp()


def is_cindy(name):
    return any(name == s or name.endswith("." + s) for s in CINDY_SUFFIXES)


def short(container):
    name = container.removeprefix("cindy-managed-")
    return name[:8] if len(name) > 30 else name


# ---------- capture metadata ----------

def load_map(directory):
    """ip -> sorted [(ts, container)], plus proxy endpoints [(host, port)]."""
    by_ip, proxies = collections.defaultdict(list), set()
    try:
        lines = open(os.path.join(directory, "map.log"), encoding="utf-8").read().splitlines()
    except FileNotFoundError:
        return by_ip, proxies
    for line in lines:
        parts = line.split()
        if len(parts) != 5:
            continue
        ts, ip, _iface, container, proxy = parts
        by_ip[ip].append((parse_time(ts), container))
        if proxy != "-" and ":" in proxy:
            host, _, port = proxy.rpartition(":")
            if port.isdigit():
                proxies.add((host.strip("[]"), int(port)))
    for entries in by_ip.values():
        entries.sort()
    return by_ip, proxies


def container_at(by_ip, ip, ts):
    entries = by_ip.get(ip)
    if not entries:
        return ip
    index = bisect.bisect_right([t for t, _ in entries], ts) - 1
    return entries[max(index, 0)][1]


def load_processes(directory):
    """(container, ip) -> {command}; sampled remote sockets inside each instance."""
    found = collections.defaultdict(set)
    try:
        lines = open(os.path.join(directory, "procs.log"), encoding="utf-8").read().splitlines()
    except FileNotFoundError:
        return found
    for line in lines:
        parts = line.split(" ", 5)
        if len(parts) < 6:
            continue
        _ts, container, _proto, endpoint, _pid, command = parts
        found[(container, endpoint.rpartition(":")[0])].add(command.strip())
    return found


# ---------- packet parsing ----------

def read_pcap(path):
    with open(path, "rb") as handle:
        header = handle.read(24)
        if len(header) < 24:
            return
        magic = header[:4]
        if magic in (b"\xd4\xc3\xb2\xa1", b"\x4d\x3c\xb2\xa1"):
            endian = "<"
        elif magic in (b"\xa1\xb2\xc3\xd4", b"\xa1\xb2\x3c\x4d"):
            endian = ">"
        else:
            return
        nano = magic in (b"\x4d\x3c\xb2\xa1", b"\xa1\xb2\x3c\x4d")
        linktype = struct.unpack(endian + "I", header[20:24])[0]
        while True:
            record = handle.read(16)
            if len(record) < 16:
                return
            sec, frac, caplen, _length = struct.unpack(endian + "IIII", record)
            data = handle.read(caplen)
            if len(data) < caplen:
                return
            yield sec + frac / (1e9 if nano else 1e6), linktype, data


def ipv4_packet(linktype, frame):
    if linktype == 1:  # Ethernet
        offset, ethertype = 14, struct.unpack("!H", frame[12:14])[0] if len(frame) >= 14 else 0
        while ethertype == 0x8100 and len(frame) >= offset + 4:
            ethertype = struct.unpack("!H", frame[offset + 2:offset + 4])[0]
            offset += 4
    elif linktype == 113:  # Linux cooked
        offset, ethertype = 16, struct.unpack("!H", frame[14:16])[0] if len(frame) >= 16 else 0
    else:
        return None
    if ethertype != 0x0800 or len(frame) < offset + 20:
        return None
    ihl = (frame[offset] & 0x0F) * 4
    proto = frame[offset + 9]
    src = str(ipaddress.IPv4Address(frame[offset + 12:offset + 16]))
    dst = str(ipaddress.IPv4Address(frame[offset + 16:offset + 20]))
    return proto, src, dst, frame[offset + ihl:]


def dns_name(message, offset, depth=0):
    labels = []
    while offset < len(message) and depth < 20:
        length = message[offset]
        if length == 0:
            return ".".join(labels), offset + 1
        if length & 0xC0 == 0xC0:
            if offset + 1 >= len(message):
                break
            pointer = ((length & 0x3F) << 8) | message[offset + 1]
            name, _ = dns_name(message, pointer, depth + 1)
            labels.append(name)
            return ".".join(labels), offset + 2
        labels.append(message[offset + 1:offset + 1 + length].decode("ascii", "replace"))
        offset += 1 + length
    return ".".join(labels), len(message)


def parse_dns(message):
    """(is_response, [question names], [(name, ipv4)], [(alias, target)])"""
    if len(message) < 12:
        return None
    flags, qd, an = struct.unpack("!HHH", message[2:8])
    offset, questions, answers, aliases = 12, [], [], []
    try:
        for _ in range(qd):
            name, offset = dns_name(message, offset)
            offset += 4
            questions.append(name.lower())
        for _ in range(an):
            name, offset = dns_name(message, offset)
            rtype, _cls, _ttl, rdlength = struct.unpack("!HHIH", message[offset:offset + 10])
            offset += 10
            rdata = message[offset:offset + rdlength]
            if rtype == 1 and rdlength == 4:
                answers.append((name.lower(), str(ipaddress.IPv4Address(rdata))))
            elif rtype == 5:
                aliases.append((name.lower(), dns_name(message, offset)[0].lower()))
            offset += rdlength
    except (struct.error, ValueError, IndexError):
        pass
    return bool(flags & 0x8000), questions, answers, aliases


def tls_sni(payload):
    try:
        if len(payload) < 44 or payload[0] != 0x16 or payload[5] != 0x01:
            return None
        offset = 9 + 2 + 32
        offset += 1 + payload[offset]
        offset += 2 + struct.unpack("!H", payload[offset:offset + 2])[0]
        offset += 1 + payload[offset]
        end = offset + 2 + struct.unpack("!H", payload[offset:offset + 2])[0]
        offset += 2
        while offset + 4 <= min(end, len(payload)):
            ext_type, ext_len = struct.unpack("!HH", payload[offset:offset + 4])
            if ext_type == 0:
                name_len = struct.unpack("!H", payload[offset + 7:offset + 9])[0]
                name = payload[offset + 9:offset + 9 + name_len]
                return name.decode("ascii", "replace").lower() if len(name) == name_len else None
            offset += 4 + ext_len
    except (struct.error, IndexError):
        return None
    return None


def proxy_target(payload):
    """Host from the first request line sent to an HTTP proxy; never reads further headers."""
    line = payload.split(b"\r\n", 1)[0][:200].decode("ascii", "replace")
    parts = line.split(" ")
    if len(parts) < 2 or parts[0] not in ("CONNECT", "GET", "POST", "HEAD", "PUT"):
        return None
    target = parts[1]
    if "://" in target:
        target = target.split("://", 1)[1].split("/", 1)[0]
    host = target.rsplit("@", 1)[-1]
    if host.startswith("["):
        return host.split("]", 1)[0].strip("[").lower() or None
    return host.rsplit(":", 1)[0].lower() or None


# ---------- report ----------

def table(headers, rows):
    if not rows:
        print("  (none)")
        return
    widths = [max(len(str(h)), *(len(str(r[i])) for r in rows)) for i, h in enumerate(headers)]
    print("  " + "  ".join(str(h).ljust(w) for h, w in zip(headers, widths)).rstrip())
    for row in rows:
        print("  " + "  ".join(str(c).ljust(w) for c, w in zip(row, widths)).rstrip())


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    directory, show_all = sys.argv[1], "--all" in sys.argv[2:]
    by_ip, proxies = load_map(directory)
    processes = load_processes(directory)
    files = sorted(glob.glob(os.path.join(directory, "cap-*.pcap")) + glob.glob(os.path.join(directory, "req-*.pcap")))
    if not files:
        sys.exit(f"No capture files in {directory}")
    instance_ips = set(by_ip)

    names_for_ip = collections.defaultdict(set)
    flows = {}            # (container, proto, dst, port) -> [count, first, last, set(sni)]
    proxied = {}          # (container, sni) -> [count, first, last]
    queries = collections.Counter()
    proxied_seen = set()
    first_ts = last_ts = None

    def bump(store, key, ts, sni=None):
        entry = store.setdefault(key, [0, ts, ts, set()])
        entry[0] += 1
        entry[1], entry[2] = min(entry[1], ts), max(entry[2], ts)
        if sni:
            entry[3].add(sni)

    def is_proxy(dst, port):
        for host, proxy_port in proxies:
            if port == proxy_port and (host == dst or not host.replace(".", "").isdigit()):
                return True
        return False

    for path in files:
        for ts, linktype, frame in read_pcap(path):
            packet = ipv4_packet(linktype, frame)
            if not packet:
                continue
            proto, src, dst, body = packet
            first_ts = ts if first_ts is None else min(first_ts, ts)
            last_ts = ts if last_ts is None else max(last_ts, ts)
            if proto == 17 and len(body) >= 8:
                sport, dport = struct.unpack("!HH", body[:4])
                if sport == 53 and dst in instance_ips:
                    parsed = parse_dns(body[8:])
                    if parsed and parsed[0]:
                        _r, questions, answers, aliases = parsed
                        # Only the name the program asked for; CNAME targets are provider infrastructure.
                        for _name, address in answers:
                            names_for_ip[address].update(questions)
                    continue
                if src not in instance_ips:
                    continue
                container = container_at(by_ip, src, ts)
                if dport == 53:
                    parsed = parse_dns(body[8:])
                    for name in (parsed[1] if parsed else []):
                        queries[(container, name)] += 1
                bump(flows, (container, "udp", dst, dport), ts)
            elif proto == 6 and len(body) >= 20 and src in instance_ips:
                sport, dport = struct.unpack("!HH", body[:4])
                data_offset, flags = (body[12] >> 4) * 4, body[13]
                container = container_at(by_ip, src, ts)
                if flags & 0x02 and not flags & 0x10:
                    bump(flows, (container, "tcp", dst, dport), ts)
                payload = body[data_offset:]
                target = proxy_target(payload) if is_proxy(dst, dport) else None
                sni = target or tls_sni(payload)
                if sni:
                    if is_proxy(dst, dport):
                        # One target per proxy connection, even if both CONNECT and inner TLS are seen.
                        if (src, sport) in proxied_seen:
                            continue
                        proxied_seen.add((src, sport))
                        entry = proxied.setdefault((container, sni), [0, ts, ts])
                        entry[0] += 1
                        entry[1], entry[2] = min(entry[1], ts), max(entry[2], ts)
                    else:
                        flows.setdefault((container, "tcp", dst, dport), [0, ts, ts, set()])[3].add(sni)

    def category(dst, port):
        if is_proxy(dst, port):
            return "proxy"
        if port == 53:
            return "dns"
        address = ipaddress.IPv4Address(dst)
        if address.is_private or address.is_loopback or address.is_link_local:
            return "local"
        return "direct"

    def label(dst, snis):
        names = sorted(snis | names_for_ip.get(dst, set()))
        return names

    print(f"Egress report: {fmt_time(first_ts)} - {fmt_time(last_ts)}" if first_ts else "Egress report: no packets")
    instances = collections.defaultdict(set)
    for ip, entries in by_ip.items():
        for _ts, container in entries:
            instances[container].add(ip)
    for container, ips in sorted(instances.items()):
        print(f"  {short(container)}  {container}  ({', '.join(sorted(ips))})")
    print(f"  proxy: {', '.join(f'{h}:{p}' for h, p in sorted(proxies)) or 'none configured'}")

    groups = collections.defaultdict(list)
    for (container, proto, dst, port), (count, first, last, snis) in flows.items():
        groups[category(dst, port)].append((container, proto, dst, port, count, first, last, snis))

    direct_rows, other_rows = [], []
    for container, proto, dst, port, count, first, last, snis in sorted(groups["direct"], key=lambda r: (r[0], -r[4])):
        names = label(dst, snis)
        basis = sorted(snis) or sorted(names_for_ip.get(dst, set()))
        cindy = bool(basis) and all(is_cindy(n) for n in basis)
        commands = sorted(processes.get((container, dst), set()))
        row = (short(container), proto, f"{dst}:{port}", ", ".join(names[:3]) + (" ..." if len(names) > 3 else "") or "?",
               count, fmt_time(first), fmt_time(last), "; ".join(commands) or "-")
        (direct_rows if cindy else other_rows).append(row)
    headers = ("instance", "proto", "destination", "names", "conns", "first", "last", "process (sampled)")

    print("\n== Direct, NOT via proxy, to non-Cindy destinations ==")
    table(headers, other_rows)
    print("\n== Direct to Cindy servers (*.cindy.app) ==")
    table(headers, direct_rows)

    print("\n== Via proxy (targets from the proxy request line or TLS inside the tunnel) ==")
    proxy_counts = collections.Counter(r[0] for r in groups["proxy"] for _ in range(r[4]))
    rows = [(short(c), sni, n, fmt_time(f), fmt_time(l)) for (c, sni), (n, f, l) in sorted(proxied.items(), key=lambda i: (i[0][0], -i[1][0]))]
    table(("instance", "target", "requests", "first", "last"), rows)
    for container, count in sorted(proxy_counts.items()):
        print(f"  {short(container)}: {count} proxy connection(s) in total")

    print("\n== Local network (other containers / host, excluding the proxy) ==")
    table(("instance", "proto", "destination", "conns", "first", "last"),
          [(short(c), p, f"{d}:{port}", n, fmt_time(f), fmt_time(l)) for c, p, d, port, n, f, l, _s in sorted(groups["local"])])

    print("\n== DNS queries ==")
    rows = sorted(queries.items(), key=lambda i: (i[0][0], -i[1]))
    if not show_all and len(rows) > 40:
        print(f"  (top 40 of {len(rows)}; use --all for everything)")
        rows = rows[:40]
    table(("instance", "name", "queries"), [(short(c), name, n) for (c, name), n in rows])


if __name__ == "__main__":
    main()
