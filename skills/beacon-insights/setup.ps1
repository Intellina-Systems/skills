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

# --- 1. Project-scoped SessionStart hook --------------------------------------
# Re-activates the skill on every session in THIS project. Written to the
# project's own .claude\settings.json - not the one in your home directory.
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "node not found - skipping the SessionStart hook."
}
else {
    $hookRel = '.agents/skills/beacon-insights/session-start-hook.mjs'
    if (-not (Test-Path (Join-Path $root ($hookRel -replace '/', '\')))) {
        $hookRel = '.claude/skills/beacon-insights/session-start-hook.mjs'
    }
    if (-not (Test-Path (Join-Path $root ($hookRel -replace '/', '\')))) {
        Write-Host "session-start-hook.mjs not found in this project - skipping the hook."
    }
    else {
        $settingsPath = Join-Path $root '.claude\settings.json'
        $merge = @'
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
  hooks: [{ type: 'command', command: `node "${'$'}{CLAUDE_PROJECT_DIR}/${hookRel}"` }],
});
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
console.log('Installed project SessionStart hook -> .claude/settings.json');
'@
        $merge | node - $settingsPath $hookRel
    }
}

# --- 2. Project-scoped agent directive ----------------------------------------
# One line in THIS repo's AGENTS.md, so non-Claude agents working here pick the
# skill up too. This is the repo telling agents about itself - the normal use of
# AGENTS.md - not an edit to any agent's global config.
$directive = "This repo uses the beacon-insights skill: report coding progress to Beacon by running the send-event helper in .agents/skills/beacon-insights (or .claude/skills/beacon-insights). See that folder's SKILL.md for when to emit what. Fire-and-forget; never let it interrupt the work."

$agentsFile = Join-Path $root 'AGENTS.md'
if ((Test-Path $agentsFile) -and (Select-String -Path $agentsFile -SimpleMatch "beacon-insights:project" -Quiet)) {
    Write-Host "Directive already in AGENTS.md - skipped."
}
else {
    $block = "`n<!-- beacon-insights:project (managed by skills/beacon-insights/setup.ps1) -->`n$directive`n<!-- /beacon-insights:project -->`n"
    Add-Content -Path $agentsFile -Value $block -Encoding utf8
    Write-Host "Added project directive to AGENTS.md"
}

Write-Host ""
Write-Host "Done - scoped to this repository only. No machine-wide changes were made."
Write-Host "Nothing to restart; it is active from the next session in this project."
