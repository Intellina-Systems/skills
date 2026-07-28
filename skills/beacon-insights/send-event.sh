#!/usr/bin/env bash
# Fire-and-forget helper to send a Beacon progress event. This is the easy way
# to emit — it auto-fills the repo and engineer, times out fast so it can never
# hang your work, and NEVER fails the caller (telemetry must not interrupt real
# work). If BEACON_API_KEY isn't set, it silently does nothing.
#
# Usage (flags):
#   bash send-event.sh --type agent.blocked --task BCN-42 \
#     --reason "API schema mismatch" --summary "Stuck on auth" --confidence 0.9
#
# Usage (full JSON body — you control everything, incl. batches):
#   bash send-event.sh --json '{"type":"agent.heartbeat","summary":"…"}'
#   bash send-event.sh --json '{"events":[{...},{...}]}'
#
# Config is resolved in this order, so the helper works standalone with no env:
#   key: $BEACON_API_KEY, else ~/.beacon/key
#   url: $BEACON_URL,     else ~/.beacon/url, else the public default
# If ~/.beacon/disabled exists, the user opted out — do nothing, ever.
#
# Never put secrets, tokens, or file contents in any field.

set -uo pipefail # deliberately NOT -e: never fail the caller

[ -f "$HOME/.beacon/disabled" ] && exit 0

BEACON_API_KEY="${BEACON_API_KEY:-$(cat "$HOME/.beacon/key" 2>/dev/null || true)}"
[ -z "${BEACON_API_KEY:-}" ] && exit 0

BEACON_URL="${BEACON_URL:-$(cat "$HOME/.beacon/url" 2>/dev/null || true)}"
BEACON_URL="${BEACON_URL:-https://beacon-tool.vercel.app}"
BEACON_URL="${BEACON_URL%/}" # tolerate a trailing slash

TYPE="" TASK="" SUMMARY="" REASON="" CONFIDENCE="" ENGINEER="" REPO="" JSON=""
while [ $# -gt 0 ]; do
  case "$1" in
    --type) TYPE="$2"; shift 2 ;;
    --task) TASK="$2"; shift 2 ;;
    --summary) SUMMARY="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --confidence) CONFIDENCE="$2"; shift 2 ;;
    --engineer) ENGINEER="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --json) JSON="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# --- auto-detect repo (org/name from the git remote, else the folder name) ---
if [ -z "$REPO" ]; then
  url="$(git remote get-url origin 2>/dev/null || true)"
  if [ -n "$url" ]; then
    url="${url%.git}"
    REPO="$(basename "$(dirname "$url")")/$(basename "$url")"
  else
    REPO="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
  fi
fi

# --- auto-detect engineer (git identity) ---
if [ -z "$ENGINEER" ]; then
  ENGINEER="$(git config user.name 2>/dev/null || true)"
  [ -z "$ENGINEER" ] && ENGINEER="$(git config user.email 2>/dev/null || true)"
fi

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g'; }

if [ -n "$JSON" ]; then
  BODY="$JSON"
else
  [ -z "$TYPE" ] && exit 0 # nothing to send
  BODY="{\"type\":\"$(json_escape "$TYPE")\""
  [ -n "$TASK" ] && BODY="$BODY,\"task\":\"$(json_escape "$TASK")\""
  [ -n "$ENGINEER" ] && BODY="$BODY,\"engineer\":\"$(json_escape "$ENGINEER")\""
  [ -n "$SUMMARY" ] && BODY="$BODY,\"summary\":\"$(json_escape "$SUMMARY")\""
  [ -n "$REASON" ] && BODY="$BODY,\"reason\":\"$(json_escape "$REASON")\""
  [ -n "$REPO" ] && BODY="$BODY,\"repo\":\"$(json_escape "$REPO")\""
  case "$CONFIDENCE" in
    '' ) ;;
    *[!0-9.]* ) ;; # not numeric — skip
    * ) BODY="$BODY,\"confidence\":$CONFIDENCE" ;;
  esac
  BODY="$BODY}"
fi

curl -sS --max-time 5 -X POST "$BEACON_URL/api/events" \
  -H "Authorization: Bearer $BEACON_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" >/dev/null 2>&1 || true
exit 0
