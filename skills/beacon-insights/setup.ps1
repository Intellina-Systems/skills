<#
Project-scoped setup for the beacon-insights skill (Windows).

Makes the skill activate automatically for THIS repository only - every
session, and every coding agent that works in it. Everything it writes lives
inside the project.

It deliberately does NOT:
  - set OS-level environment variables
  - edit any shell profile
  - touch ~/.claude/settings.json or any other machine-wide agent config
  - write to ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, or ~/.gemini/GEMINI.md

Those are machine-wide persistence and cross-agent self-propagation. This
script does not do them, and no version of it should. If you want Beacon in
another repo, run the install there - that is the only way it should spread.

The single exception is ~/.beacon/key, your credential store. This script
never writes it; it only reads it, the same way git reads ~/.gitconfig.

Safe to re-run: every step is idempotent.

  powershell -File setup.ps1
#>

$ErrorActionPreference = 'SilentlyContinue'

$skillDir = $PSScriptRoot
$root = (git rev-parse --show-toplevel 2>$null)
if ($root) { $root = $root -replace '/', '\' } else { $root = (Get-Location).Path }

# --- Key must already exist. This script never asks for or stores one. --------
$hasKey = [bool]$env:BEACON_API_KEY
if (-not $hasKey) {
    $keyFile = Join-Path $HOME '.beacon\key'
    if (Test-Path $keyFile) { $hasKey = ((Get-Content $keyFile -Raw).Trim().Length -gt 0) }
}
if (-not $hasKey) {
    Write-Host "No Beacon API key found."
    Write-Host "Create one first:  mkdir `"`$HOME\.beacon`" -Force; Set-Content `"`$HOME\.beacon\key`" 'bcn_YOUR_KEY' -NoNewline"
    exit 0
}

# --- 1. Project-scoped hooks: SessionStart, PostToolUse, Stop, SessionEnd --
# This is the deterministic layer: presence/activity gets reported by hooks,
# not by the model remembering to run a script. Written to the project's own
# .claude\settings.json - not the one in your home directory.
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "node not found - skipping the hooks."
}
else {
    $skillRel = '.agents/skills/beacon-insights'
    if (-not (Test-Path (Join-Path $root (($skillRel + '/beacon-hook.mjs') -replace '/', '\')))) {
        $skillRel = '.claude/skills/beacon-insights'
    }
    if (-not (Test-Path (Join-Path $root (($skillRel + '/beacon-hook.mjs') -replace '/', '\')))) {
        Write-Host "beacon-hook.mjs not found in this project - skipping the hooks."
    }
    else {
        $settingsPath = Join-Path $root '.claude\settings.json'
        node (Join-Path $skillDir 'merge-settings.mjs') $settingsPath $skillRel
    }
}

# --- 2. Fresh install: project directive, and old leftovers removed ------------
# The one line in THIS repo's AGENTS.md (so non-Claude agents pick the skill up)
# is rewritten to the current text every run. Old versions of this skill wrote
# a Beacon note into machine-wide agent files; if one is still there it is
# removed - only the block between Beacon's own markers, nothing else.
if (Get-Command node -ErrorAction SilentlyContinue) {
    node (Join-Path $skillDir 'fresh-install.mjs') $root
}
else {
    Write-Host "node not found - the project directive was not updated."
}

Write-Host ""
Write-Host "Done - scoped to this repository only. The only change outside it is removing an outdated Beacon note, if an older version left one."
Write-Host "Nothing to restart; it is active from the next session in this project."
