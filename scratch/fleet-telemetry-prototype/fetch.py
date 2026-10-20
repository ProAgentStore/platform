"""Snapshot every runner machine's resource history to CSV.

Prototype only: talks to the ProAgentStore MCP through the signed-in
`pags mcp` stdio proxy, calls list_runner_nodes and runner_resource_history
(coarse tier, 24h), and writes the two CSVs dashboard.html reads. The real
feature should read the same store server-side and stream it live.

    python3 fetch.py   # writes runner-machines.csv, runner-telemetry-24h.csv
"""
import csv, json, select, subprocess, sys, time

p = subprocess.Popen(['pags', 'mcp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True)


def send(m):
    p.stdin.write(json.dumps(m) + "\n")
    p.stdin.flush()


def recv(i, t=120):
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([p.stdout], [], [], end - time.time())
        if not r:
            break
        line = p.stdout.readline()
        if not line:
            break
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get('id') == i:
            return m
    p.kill()
    sys.exit("pags mcp: no response")


send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "telemetry", "version": "1"}}})
recv(1)
send({"jsonrpc": "2.0", "method": "notifications/initialized"})
_n = [10]


def call(name, args):
    _n[0] += 1
    send({"jsonrpc": "2.0", "id": _n[0], "method": "tools/call", "params": {"name": name, "arguments": args}})
    m = recv(_n[0])
    if 'error' in m:
        sys.exit(f"{name}: {m['error']}")
    return json.loads(m['result']['content'][0]['text'])


def paged(name, args, key):
    out, off = [], 0
    while True:
        r = call(name, {**args, **({"offset": off} if off else {})})
        out += r[key]
        if not r['page']['hasMore']:
            return out
        off = r['page']['nextOffset']


nodes = paged('list_runner_nodes', {}, 'nodes')
p_name = {'darwin': 'macOS', 'win32': 'Windows'}
with open('runner-machines.csv', 'w', newline='') as mf, open('runner-telemetry-24h.csv', 'w', newline='') as tf:
    mw, tw = csv.writer(mf), csv.writer(tf)
    mw.writerow(['machine', 'hostname', 'platform', 'cpus', 'mem_gb', 'kept_alive_by', 'connected',
                 'active_sessions', 'recommended_max_sessions', 'runner_version', 'last_seen_utc'])
    tw.writerow(['machine', 'at', 'load_per_cpu', 'mem_used_pct', 'disk_used_pct', 'relay_rtt_ms',
                 'runner_starts_24h', 'heavy_sessions'])
    for n in nodes:
        res = n.get('resources') or {}
        name = n.get('displayName') or n['node']
        mw.writerow([name, n['node'], p_name.get(res.get('platform'), res.get('platform')), res.get('cpus'),
                     round((res.get('memTotalBytes') or 0) / 2**30), n.get('supervisor'),
                     'yes' if n['connected'] else 'no', res.get('activeSessions'),
                     res.get('recommendedMaxSessions'), n.get('runnerVersion'), n.get('lastSeenAt')])
        windows = res.get('platform') == 'win32'  # Windows has no load average; it reports 0
        for s in paged('runner_resource_history', {"node": n['node'], "tier": "coarse"}, 'samples'):
            load = s.get('loadPerCpu')
            tw.writerow([name, s['at'], '' if windows or load is None else load, s.get('memUsedPct'),
                         s.get('diskUsedPct'), '' if s.get('relayRttMs') is None else s['relayRttMs'],
                         s.get('starts24h'), len(s.get('topSessions') or [])])
        print(name, file=sys.stderr)
p.kill()
