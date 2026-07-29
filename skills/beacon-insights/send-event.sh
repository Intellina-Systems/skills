#!/usr/bin/env bash
# Fire-and-forget helper to send a Beacon progress event. This is the easy way
# to emit — it auto-fills the repo and engineer, times out fast so it can never
# hang your work, and NEVER fails the caller (telemetry must not interrupt real
# work). If BEACON_API_KEY isn't set, it silently does nothing.
#
# Usage (positional — the short form most callers reach for):
#   bash send-event.sh agent.heartbeat "Refactoring session middleware"
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
    # Bare words: accept the shape callers actually reach for,
    # `send-event.sh <type> "<summary>"`. The first one is only taken as the
    # type when it *looks* like one (dotted lowercase, e.g. agent.heartbeat),
    # so a stray argument becomes a summary rather than a bogus event type.
    # Anything left over is dropped — but never in silence, because an argument
    # quietly discarded here means an event nobody ever finds out was lost.
    *)
      if [ -z "$TYPE" ] && printf '%s' "$1" | grep -qE '^[a-z][a-z_]*\.[a-z][a-z_]*$'; then
        TYPE="$1"
      elif [ -z "$SUMMARY" ]; then
        SUMMARY="$1"
      else
        echo "send-event: ignoring unrecognized argument '$1'" >&2
      fi
      shift ;;
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
  # Still exit 0 — telemetry never fails the caller — but say so, or a caller
  # with the wrong syntax gets a clean exit and an empty dashboard forever.
  [ -z "$TYPE" ] && {
    echo "send-event: no event type given, nothing sent (try: send-event.sh agent.heartbeat \"summary\")" >&2
    exit 0
  }
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

# Discard the response body, keep the status. A revoked key, a malformed
# payload, and a working send are otherwise indistinguishable — all exit 0 —
# which is how telemetry stays broken for weeks without anyone noticing.
# curl prints 000 itself when it never got a response, so no `|| echo` fallback
# here — that would concatenate with curl's own output. The :- covers curl
# being absent entirely.
STATUS="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
  -X POST "$BEACON_URL/api/events" \
  -H "Authorization: Bearer $BEACON_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" 2>/dev/null)"
STATUS="${STATUS:-000}"

case "$STATUS" in
  2*) ;; # delivered — stay quiet, this runs constantly
  000) echo "send-event: could not reach Beacon at $BEACON_URL (offline or timed out)" >&2 ;;
  401 | 403) echo "send-event: Beacon rejected the API key (HTTP $STATUS) — it may have been revoked" >&2 ;;
  *) echo "send-event: Beacon rejected the event (HTTP $STATUS)" >&2 ;;
esac

exit 0 # always, whatever happened above
