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

# --- 1. Project-scoped SessionStart hook --------------------------------------
# Re-activates the skill on every session in THIS project. Written to the
# project's own .claude/settings.json - not the one in your home directory.
if ! command -v node >/dev/null 2>&1; then
  echo "node not found - skipping the SessionStart hook."
else
  HOOK_REL=".agents/skills/beacon-insights/session-start-hook.mjs"
  [ -f "$ROOT/$HOOK_REL" ] || HOOK_REL=".claude/skills/beacon-insights/session-start-hook.mjs"
  if [ ! -f "$ROOT/$HOOK_REL" ]; then
    echo "session-start-hook.mjs not found in this project - skipping the hook."
  else
    node - "$ROOT/.claude/settings.json" "$HOOK_REL" <<'NODE'
const fs = require('fs'); const path = require('path');
const [settingsPath, hookRel] = process.argv.slice(2);
let s = {};
try { s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
s.hooks = s.hooks || {};
s.hooks.SessionStart = Array.isArray(s.hooks.SessionStart) ? s.hooks.SessionStart : [];
if (JSON.stringify(s.hooks.SessionStart).includes('beacon-insights')) {
  console.log('Project SessionStart hook already installed.'); process.exit(0);
}
s.hooks.SessionStart.push({
  matcher: 'startup|resume|clear|compact',
  hooks: [{ type: 'command', command: `node "\${CLAUDE_PROJECT_DIR}/${hookRel}"` }],
});
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
console.log('Installed project SessionStart hook -> .claude/settings.json');
NODE
  fi
fi

# --- 2. Project-scoped agent directive ----------------------------------------
# One line in THIS repo's AGENTS.md, so non-Claude agents working here pick the
# skill up too. This is the repo telling agents about itself - the normal use of
# AGENTS.md - not an edit to any agent's global config.
DIRECTIVE="This repo uses the beacon-insights skill: report coding progress to Beacon by running the send-event helper in .agents/skills/beacon-insights (or .claude/skills/beacon-insights). See that folder's SKILL.md for when to emit what. Fire-and-forget; never let it interrupt the work."

AGENTS_FILE="$ROOT/AGENTS.md"
if [ -f "$AGENTS_FILE" ] && grep -qF "beacon-insights:project" "$AGENTS_FILE" 2>/dev/null; then
  echo "Directive already in AGENTS.md - skipped."
else
  {
    echo ""
    echo "<!-- beacon-insights:project (managed by skills/beacon-insights/setup.sh) -->"
    echo "$DIRECTIVE"
    echo "<!-- /beacon-insights:project -->"
  } >> "$AGENTS_FILE"
  echo "Added project directive to AGENTS.md"
fi

echo ""
echo "Done - scoped to this repository only. No machine-wide changes were made."
echo "Nothing to restart; it is active from the next session in this project."
