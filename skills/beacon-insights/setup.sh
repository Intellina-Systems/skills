#!/usr/bin/env bash
# Project-scoped setup for the beacon-insights skill.
#
# Makes the skill activate automatically for THIS repository only - every
# session, and every coding agent that works in it. Everything it writes lives
# inside the project.
#
# It deliberately does NOT:
#   - set OS-level environment variables
#   - edit ~/.bashrc, ~/.zshrc, or any shell profile
#   - touch ~/.claude/settings.json or any other machine-wide agent config
#   - write to ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, or ~/.gemini/GEMINI.md
#
# Those are machine-wide persistence and cross-agent self-propagation. This
# script does not do them, and no version of it should. If you want Beacon in
# another repo, run the install there - that is the only way it should spread.
#
# The single exception is ~/.beacon/key, your credential store. This script
# never writes it; it only reads it, the same way git reads ~/.gitconfig.
#
# Safe to re-run: every step is idempotent.
#
#   bash setup.sh

set -uo pipefail # deliberately NOT -e: never fail the caller

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# --- Key must already exist. This script never asks for or stores one. --------
KEY="${BEACON_API_KEY:-}"
[ -z "$KEY" ] && [ -s "$HOME/.beacon/key" ] && KEY="$(cat "$HOME/.beacon/key")"
if [ -z "$KEY" ]; then
  echo "No Beacon API key found."
  echo "Create one first:  mkdir -p ~/.beacon && printf %s 'bcn_YOUR_KEY' > ~/.beacon/key && chmod 600 ~/.beacon/key"
  exit 0
fi
unset KEY # don't keep it in memory; we only needed to know it exists

# --- 1. Project-scoped hooks: SessionStart, PostToolUse, Stop, SessionEnd --
# This is the deterministic layer: presence/activity gets reported by hooks,
# not by the model remembering to run a script. Written to the project's own
# .claude/settings.json - not the one in your home directory.
if ! command -v node >/dev/null 2>&1; then
  echo "node not found - skipping the hooks."
else
  SKILL_REL=".agents/skills/beacon-insights"
  [ -f "$ROOT/$SKILL_REL/beacon-hook.mjs" ] || SKILL_REL=".claude/skills/beacon-insights"
  if [ ! -f "$ROOT/$SKILL_REL/beacon-hook.mjs" ]; then
    echo "beacon-hook.mjs not found in this project - skipping the hooks."
  else
    node "$SKILL_DIR/merge-settings.mjs" "$ROOT/.claude/settings.json" "$SKILL_REL"
  fi
fi

# --- 2. Fresh install: project directive, and old leftovers removed ------------
# The one line in THIS repo's AGENTS.md (so non-Claude agents pick the skill up)
# is rewritten to the current text every run. Old versions of this skill wrote
# a Beacon note into machine-wide agent files; if one is still there it is
# removed — only the block between Beacon's own markers, nothing else.
if command -v node >/dev/null 2>&1; then
  node "$SKILL_DIR/fresh-install.mjs" "$ROOT"
else
  echo "node not found - the project directive was not updated."
fi

echo ""
echo "Done - scoped to this repository only. The only change outside it is removing an outdated Beacon note, if an older version left one."
echo "Nothing to restart; it is active from the next session in this project."
