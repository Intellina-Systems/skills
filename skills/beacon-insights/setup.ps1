<#
One-time, per-machine setup for the beacon-insights skill (Windows). It:
  1. Sets BEACON_API_KEY + BEACON_URL as persistent user environment variables,
     so every coding agent/IDE inherits them.
  2. Links the skill into ~/.claude/skills so Claude Code discovers it in every
     repo (and this repo, unless it already lives under a .claude/skills path).
  3. Wires it to AUTO-LOAD every session: a Claude Code SessionStart hook plus a
     directive in your global agent memory files (Claude/Codex/Gemini).

Safe to re-run: every step is idempotent.

  powershell -ExecutionPolicy Bypass -File setup.ps1            # uses a saved key, else prompts
  powershell -ExecutionPolicy Bypass -File setup.ps1 bcn_xxx    # explicit

The key is resolved in this order: -ApiKey, $env:BEACON_API_KEY, ~/.beacon/key.
Only if none of those exist does it prompt - and when there's no console to
prompt on (an agent's shell), it exits quietly instead of hanging.
#>

param(
    [string]$ApiKey,
    [string]$BeaconUrl
)

$beaconDir = Join-Path $HOME '.beacon'

if (-not $ApiKey) { $ApiKey = $env:BEACON_API_KEY }
if (-not $ApiKey) {
    $keyFile = Join-Path $beaconDir 'key'
    if (Test-Path $keyFile) { $ApiKey = (Get-Content $keyFile -Raw).Trim() }
}
if (-not $ApiKey) {
    if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
        $ApiKey = Read-Host "Paste your Beacon API key (Beacon -> Settings -> API Keys, starts with bcn_)"
    }
    else {
        Write-Host "No Beacon API key found and no console to prompt on - nothing to do."
        exit 0
    }
}
if (-not $ApiKey) { exit 0 }
if (-not $ApiKey.StartsWith("bcn_")) {
    Write-Warning "That doesn't look like a Beacon API key (should start with 'bcn_'). Continuing anyway."
}

if (-not $BeaconUrl) { $BeaconUrl = $env:BEACON_URL }
if (-not $BeaconUrl) {
    $urlFile = Join-Path $beaconDir 'url'
    if (Test-Path $urlFile) { $BeaconUrl = (Get-Content $urlFile -Raw).Trim() }
}
if (-not $BeaconUrl) { $BeaconUrl = "https://beacon-tool.vercel.app" }

# --- 1. Persistent env vars (user-level) --------------------------------------
[Environment]::SetEnvironmentVariable("BEACON_API_KEY", $ApiKey, "User")
[Environment]::SetEnvironmentVariable("BEACON_URL", $BeaconUrl, "User")
Write-Host "Env vars set for your Windows account." -ForegroundColor Green

# --- 2. Skill discovery links -------------------------------------------------
$skillSourceDir = $PSScriptRoot

function Install-SkillLink {
    param([string]$LinkPath, [string]$Label)
    if (Get-Item -Path $LinkPath -ErrorAction SilentlyContinue) {
        Write-Host "$Label already present: $LinkPath"
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $LinkPath -Parent) | Out-Null
    New-Item -ItemType Junction -Path $LinkPath -Target $skillSourceDir | Out-Null
    Write-Host "$Label linked: $LinkPath"
}

# User-level link - available in every repo on this machine.
Install-SkillLink -LinkPath (Join-Path $HOME ".claude\skills\beacon-insights") -Label "User-level skill (every repo)"

# Project-level link only when the skill isn't already under a .claude\skills
# path (installed there it's already discoverable, and guessing the repo root
# two levels up is what created the old stray nested junction). Use git for the
# real repo root.
if ($skillSourceDir -match '[\\/]\.claude[\\/]skills[\\/]') {
    Write-Host "Skill already lives under .claude/skills - no project link needed."
}
else {
    $repoRoot = (git -C $skillSourceDir rev-parse --show-toplevel 2>$null)
    if ($repoRoot) {
        $repoRoot = $repoRoot -replace '/', '\'
        Install-SkillLink -LinkPath (Join-Path $repoRoot ".claude\skills\beacon-insights") -Label "Project-level skill"
    }
}

# --- 3. Auto-load: SessionStart hook + global memory directive ----------------
# (a) SessionStart hook, merged safely into ~/.claude/settings.json.
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $settingsPath = Join-Path $HOME ".claude\settings.json"
    $hookScript = (Join-Path $HOME ".claude\skills\beacon-insights\session-start-hook.mjs") -replace '\\', '/'
    $merge = @'
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
'@
    $merge | node - $settingsPath $hookScript
}
else {
    Write-Host "node not found - skipping the SessionStart hook (memory directive still added)."
}

# (b) Static directive in each agent's global memory file it can find.
$directive = "When BEACON_API_KEY is set, the beacon-insights skill is active: throughout every coding task, report progress to Beacon by running the send-event helper in ~/.claude/skills/beacon-insights - agent.session_started at task start, agent.planning, agent.implementation_started, agent.heartbeat every ~15-20 tool calls, agent.blocked (with a reason) when stuck, agent.completed when done. Include the repo. Fire-and-forget; never let it interrupt the work. See ~/.claude/skills/beacon-insights/SKILL.md."

function Add-Memory {
    param([string]$File)
    if ((Test-Path $File) -and (Select-String -Path $File -SimpleMatch "beacon-insights:auto" -Quiet)) {
        Write-Host "Directive already in $File - skipped."
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $File -Parent) | Out-Null
    $block = "`n<!-- beacon-insights:auto (managed by skills/beacon-insights/setup.ps1) -->`n$directive`n<!-- /beacon-insights:auto -->`n"
    Add-Content -Path $File -Value $block -Encoding utf8
    Write-Host "Added beacon directive to $File."
}

Add-Memory (Join-Path $HOME ".claude\CLAUDE.md")
if (Test-Path (Join-Path $HOME ".codex")) { Add-Memory (Join-Path $HOME ".codex\AGENTS.md") }
if (Test-Path (Join-Path $HOME ".gemini")) { Add-Memory (Join-Path $HOME ".gemini\GEMINI.md") }

Write-Host ""
Write-Host "Restart any open terminals, IDEs, or coding agents once so they pick everything up." -ForegroundColor Yellow
