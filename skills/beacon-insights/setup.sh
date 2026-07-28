#!/usr/bin/env bash
# One-time, per-machine setup for the beacon-insights skill. It:
#   1. Persists BEACON_API_KEY + BEACON_URL to your LOGIN shell's profile, so
#      every coding agent/IDE inherits them (they all run as your user).
#   2. Links the skill into ~/.claude/skills so Claude Code discovers it in
#      every repo (and this repo, unless it's already under a .claude/skills path).
#   3. Wires it to AUTO-LOAD every session: a Claude Code SessionStart hook plus
#      a directive in your global agent memory files (Claude/Codex/Gemini).
#
# Safe to re-run: every step is idempotent.
#
#   bash setup.sh            # uses a saved key, else prompts
#   bash setup.sh bcn_xxx    # explicit
#
# The key is resolved in this order: $1, $BEACON_API_KEY, ~/.beacon/key. Only if
# none of those exist does it prompt - and with no TTY (an agent's shell) it
# exits quietly instead of hanging.

set -euo pipefail

BEACON_URL_DEFAULT="https://beacon-tool.vercel.app"

API_KEY="${1:-${BEACON_API_KEY:-}}"
if [ -z "$API_KEY" ] && [ -s "$HOME/.beacon/key" ]; then
  API_KEY="$(cat "$HOME/.beacon/key")"
fi
if [ -z "$API_KEY" ]; then
  if [ -t 0 ]; then
    read -rp "Paste your Beacon API key (Beacon -> Settings -> API Keys, starts with bcn_): " API_KEY
  else
    echo "No Beacon API key found and no TTY to prompt on - nothing to do."
    exit 0
  fi
fi
[ -z "$API_KEY" ] && exit 0

BEACON_URL="${2:-${BEACON_URL:-}}"
if [ -z "$BEACON_URL" ] && [ -s "$HOME/.beacon/url" ]; then
  BEACON_URL="$(cat "$HOME/.beacon/url")"
fi
BEACON_URL="${BEACON_URL:-$BEACON_URL_DEFAULT}"

case "$API_KEY" in
  bcn_*) ;;
  *) echo "Warning: that doesn't look like a Beacon API key (should start with 'bcn_'). Continuing anyway." >&2 ;;
esac

# --- 1. Persistent env vars into every shell profile this user might load ------
# $SHELL is unreliable here: it reflects the login shell in the passwd database,
# but running via `bash setup.sh` from an interactive zsh session can make a
# nested shell see the wrong value (that's exactly what happened on at least one
# machine: a zsh login shell, but $SHELL resolved to bash inside the script, so
# the key landed in ~/.bashrc and a zsh session never sourced it). Rather than
# guess which shell is authoritative, write to both common profiles — each guard
# is idempotent, so this is safe to re-run regardless of which shell is active.
write_env_block() {
  local profile="$1"
  mkdir -p "$(dirname "$profile")"
  if [ -f "$profile" ] && grep -q "BEACON_API_KEY" "$profile" 2>/dev/null; then
    echo "Env vars already present in $profile - skipped."
  else
    {
      echo ""
      echo "# Beacon insights (added by skills/beacon-insights/setup.sh)"
      echo "export BEACON_API_KEY=\"$API_KEY\""
      echo "export BEACON_URL=\"$BEACON_URL\""
    } >> "$profile"
    echo "Added env vars to $profile."
  fi
}

write_env_block "$HOME/.zshrc"
write_env_block "$HOME/.bashrc"

# --- 2. Skill discovery links --------------------------------------------------
skill_source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

link_skill() {
  local link_path="$1" label="$2"
  if [ -e "$link_path" ] || [ -L "$link_path" ]; then
    echo "$label already present: $link_path"
    return
  fi
  mkdir -p "$(dirname "$link_path")"
  ln -s "$skill_source_dir" "$link_path"
  echo "$label linked: $link_path"
}

# User-level link — makes the skill available in EVERY repo on this machine.
link_skill "$HOME/.claude/skills/beacon-insights" "User-level skill (every repo)"

# Project-level link — only when the skill isn't already sitting inside a
# .claude/skills/ path (installed there by `npx skills`, it's already
# discoverable, and guessing the repo root two levels up is what created the
# old stray .claude/.claude symlink). Use git to find the real repo root.
case "$skill_source_dir" in
  */.claude/skills/*)
    echo "Skill already lives under .claude/skills - no project link needed."
    ;;
  *)
    repo_root="$(git -C "$skill_source_dir" rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$repo_root" ]; then
      link_skill "$repo_root/.claude/skills/beacon-insights" "Project-level skill"
    fi
    ;;
esac

# --- 3. Auto-load: SessionStart hook + global memory directive -----------------
# (a) Claude Code SessionStart hook — deterministically reminds the agent to use
#     the skill at the start of every session. Merged safely into settings.json.
install_hook() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node not found - skipping the SessionStart hook (memory directive still added)."
    return
  fi
  node - "$HOME/.claude/settings.json" "$HOME/.claude/skills/beacon-insights/session-start-hook.mjs" <<'NODE'
const fs = require('fs'); const path = require('path');
const [settingsPath, hookScript] = process.argv.slice(2);
let s = {};
try { s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
s.hooks = s.hooks || {};
s.hooks.SessionStart = Array.isArray(s.hooks.SessionStart) ? s.hooks.SessionStart : [];
if (JSON.stringify(s.hooks.SessionStart).includes('session-start-hook')) {
  console.log('SessionStart hook already installed.'); process.exit(0);
}
s.hooks.SessionStart.push({
  matcher: 'startup|resume|clear|compact',
  hooks: [{ type: 'command', command: `node "${hookScript}"` }],
});
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
console.log('Installed SessionStart hook - the skill now auto-loads every session.');
NODE
}
install_hook

# (b) Static directive in each agent's GLOBAL memory file it can find. The hook
#     covers Claude Code; this covers other agents (and is the doc-recommended
#     place for static, always-on context).
BEACON_DIRECTIVE="When BEACON_API_KEY is set, the beacon-insights skill is active: throughout every coding task, report progress to Beacon by running ~/.claude/skills/beacon-insights/send-event.sh — agent.session_started at task start, agent.planning, agent.implementation_started, agent.heartbeat every ~15-20 tool calls, agent.blocked (with a reason) when stuck, agent.completed when done. Include the repo. Fire-and-forget; never let it interrupt the work. See ~/.claude/skills/beacon-insights/SKILL.md."

add_memory() {
  local file="$1"
  [ -f "$file" ] && grep -qF "beacon-insights:auto" "$file" 2>/dev/null && { echo "Directive already in $file - skipped."; return; }
  mkdir -p "$(dirname "$file")"
  {
    echo ""
    echo "<!-- beacon-insights:auto (managed by skills/beacon-insights/setup.sh) -->"
    echo "$BEACON_DIRECTIVE"
    echo "<!-- /beacon-insights:auto -->"
  } >> "$file"
  echo "Added beacon directive to $file."
}

add_memory "$HOME/.claude/CLAUDE.md"                     # Claude Code (every repo)
[ -d "$HOME/.codex" ] && add_memory "$HOME/.codex/AGENTS.md"    # Codex
[ -d "$HOME/.gemini" ] && add_memory "$HOME/.gemini/GEMINI.md"  # Gemini CLI

# --- Done ----------------------------------------------------------------------
echo ""
echo "Restart your terminal (and any IDE/agent launched from one) once so it picks everything up."

if [[ "${OSTYPE:-}" == darwin* ]]; then
  echo ""
  echo "macOS note: apps launched from Dock/Spotlight (not a terminal) don't read shell"
  echo "profiles. If your coding tool is launched that way, also run:"
  echo "  launchctl setenv BEACON_API_KEY \"$API_KEY\""
  echo "  launchctl setenv BEACON_URL \"$BEACON_URL\""
  echo "(resets on reboot - wrap it in a LaunchAgent if you need it to survive one)."
fi
