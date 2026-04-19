#!/usr/bin/env bash
# Repro for smolvm/libkrun TSI: idle keep-alive HTTP connections from guest to
# host are silently killed after a few minutes, deadlocking the next reuse.
#
# Setup: starts a host HTTP server, boots an alpine smolvm with --net, opens
# a Python HTTP keep-alive connection from the guest, sends 5 requests
# (instant), idles 6 minutes, then tries to reuse the connection.
#
# Expected: all 10 requests succeed.
# Actual (smolvm 0.5.19): #5..9 fail with TimeoutError / CannotSendRequest.
#
# Usage: ./smolvm-tsi-idle-repro.sh
# Tested: smolvm 0.5.19, macOS 14 (darwin-arm64).
set -euo pipefail

PORT=7779
VM=tsi-idle-repro
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"; smolvm machine stop --name "$VM" 2>/dev/null || true; smolvm machine delete -f "$VM" 2>/dev/null || true; [[ -n "${SRV_PID:-}" ]] && kill "$SRV_PID" 2>/dev/null || true' EXIT

cat > "$TMPDIR/server.mjs" <<EOF
import http from 'node:http';
const s = http.createServer((_, r) => r.end('ok\n'));
s.listen($PORT, '0.0.0.0', () => console.log('[host] listening on $PORT'));
EOF

cat > "$TMPDIR/reuse.py" <<EOF
import http.client, time
c = http.client.HTTPConnection('127.0.0.1', $PORT, timeout=30)
def req(label):
    t = time.time()
    try:
        c.request('GET', '/x'); r = c.getresponse(); body = r.read()
        print(f"{label}: status={r.status} t={time.time()-t:.3f}s", flush=True)
    except Exception as e:
        print(f"{label}: FAIL {type(e).__name__}: {e} t={time.time()-t:.3f}s", flush=True)
for i in range(5):    req(f"req#{i}")
print("idle 360s on the same connection...", flush=True)
time.sleep(360)
for i in range(5,10): req(f"req#{i}-after-idle")
EOF

echo "[repro] starting host server..."
node "$TMPDIR/server.mjs" &
SRV_PID=$!
sleep 1
curl -fsS "http://127.0.0.1:$PORT/sanity" >/dev/null

echo "[repro] booting smolvm..."
smolvm machine create -I alpine --net -v "$TMPDIR:/host:ro" "$VM" >/dev/null
smolvm machine start --name "$VM" >/dev/null
sleep 5
smolvm machine exec --name "$VM" -- sh -c "apk add --no-cache python3 >/dev/null 2>&1 && echo python3 ready"

echo "[repro] running reuse test (will take ~6 minutes)..."
smolvm machine exec --name "$VM" -- python3 /host/reuse.py
