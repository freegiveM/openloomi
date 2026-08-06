#!/usr/bin/env bash
# Diagnose which models the OpenLoomi server actually knows about and which
# upstream providers it can reach. Run inside WSL.

set -u

HOST_IP=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null || echo "127.0.0.1")
URL="http://${HOST_IP}:3515/api/native/agent"
TOKEN=$(cat /mnt/c/Users/32274/.openloomi/token | tr -d '[:space:]')

bold() { printf "\n\033[1;36m==== %s ====\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m%s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m%s\033[0m\n" "$*"; }

bold "Test 1: tiny ping with model=claude-sonnet-4-5"
RESP=$(curl -sS -w "\n__HTTP__%{http_code}" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -X POST --max-time 30 \
    -d '{"prompt":"respond with the single word ok","provider":"claude","model":"claude-sonnet-4-5"}' \
    "$URL" 2>&1)
echo "$RESP" | head -40
echo ""

bold "Test 2: same ping with model=MiniMax-M3-highspeed"
RESP=$(curl -sS -w "\n__HTTP__%{http_code}" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -X POST --max-time 30 \
    -d '{"prompt":"respond with the single word ok","provider":"claude","model":"MiniMax-M3-highspeed"}' \
    "$URL" 2>&1)
echo "$RESP" | head -40
echo ""

bold "Test 3: try provider=openai instead of claude"
RESP=$(curl -sS -w "\n__HTTP__%{http_code}" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -X POST --max-time 30 \
    -d '{"prompt":"respond with the single word ok","provider":"openai","model":"gpt-5"}' \
    "$URL" 2>&1)
echo "$RESP" | head -40
echo ""

bold "Test 4: try the upstream Anthropic endpoint directly with the configured token"
ANTHROPIC_TOKEN="sk-cp-vaKirCaOffifXjVc9SDDZG7sl2DSGkugGrhKMLhXESW7P4wksXdRElDY3m03Tw-ZjcPwzsoPU6A-3YNBUzQN1qh6iww8F9lC8sxzudNpJppM2jZmPVkkMWM"
ANTHROPIC_BASE="https://api.minimaxi.com/anthropic"
RESP=$(curl -sS -w "\n__HTTP__%{http_code}" \
    -H "x-api-key: $ANTHROPIC_TOKEN" \
    -H "anthropic-version: 2023-06-01" \
    -H "Content-Type: application/json" \
    -X POST --max-time 20 \
    -d '{"model":"claude-sonnet-4-5","max_tokens":10,"messages":[{"role":"user","content":"say ok"}]}' \
    "$ANTHROPIC_BASE/v1/messages" 2>&1)
echo "$RESP" | head -30
echo ""

bold "Test 5: try MiniMax-M3 directly at MiniMax anthropic endpoint"
RESP=$(curl -sS -w "\n__HTTP__%{http_code}" \
    -H "x-api-key: $ANTHROPIC_TOKEN" \
    -H "anthropic-version: 2023-06-01" \
    -H "Content-Type: application/json" \
    -X POST --max-time 20 \
    -d '{"model":"MiniMax-M3-highspeed","max_tokens":10,"messages":[{"role":"user","content":"say ok"}]}' \
    "$ANTHROPIC_BASE/v1/messages" 2>&1)
echo "$RESP" | head -30
