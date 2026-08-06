#!/usr/bin/env bash
# Probe whether OpenLoomi's /api/native/agent is reachable from WSL.
# Run inside WSL:
#   bash /mnt/d/openloomi3/openloomi/benchmark/continual-learning-bench/scripts/probe-openloomi.sh

set -u

TOKEN_FILE="/mnt/c/Users/32274/.openloomi/token"
HOST_IP=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null || echo "127.0.0.1")
URL="http://${HOST_IP}:3515/api/native/agent"

echo "==== config ===="
echo "WSL host IP = $HOST_IP"
echo "URL = $URL"
echo "Token file = $TOKEN_FILE"
if [ ! -f "$TOKEN_FILE" ]; then
    echo "FAIL: token file not found"
    exit 1
fi
TOKEN=$(cat "$TOKEN_FILE" | tr -d '[:space:]')
echo "Token length = ${#TOKEN} (first 30 chars: ${TOKEN:0:30}...)"
echo ""

echo "==== TCP probe: is port 3515 open? ===="
if (echo > /dev/tcp/${HOST_IP}/3515) 2>/dev/null; then
    echo "  TCP connect OK"
else
    echo "  TCP connect FAILED -> OpenLoomi server may not be running, or bound to 127.0.0.1"
    echo "  -> Check OpenLoomi server status; ensure it listens on 0.0.0.0:3515"
    exit 1
fi
echo ""

echo "==== HTTP POST /api/native/agent ===="
RESPONSE=$(curl -sS -w "\n__HTTP_STATUS__%{http_code}\n__TIME__%{time_total}\n" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -X POST \
    -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"say hi in 3 words"}]}' \
    --max-time 60 \
    "$URL" 2>&1)
echo "$RESPONSE"
echo ""

echo "==== verdict ===="
if echo "$RESPONSE" | grep -q "__HTTP_STATUS__200"; then
    echo "  ✅ OpenLoomi agent API is fully working"
elif echo "$RESPONSE" | grep -q "__HTTP_STATUS__401\|__HTTP_STATUS__403"; then
    echo "  ❌ Auth failed (401/403). Token may be expired; restart OpenLoomi server to refresh."
elif echo "$RESPONSE" | grep -q "__HTTP_STATUS__404"; then
    echo "  ❌ 404. Server is up but /api/native/agent not registered. Check OpenLoomi server logs."
elif echo "$RESPONSE" | grep -q "__HTTP_STATUS__5"; then
    echo "  ⚠️  5xx. Server is up but errored; check OpenLoomi server logs."
else
    echo "  ⚠️  Unknown response; check above"
fi
