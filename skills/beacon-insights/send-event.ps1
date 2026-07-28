<#
Fire-and-forget helper to send a Beacon progress event (Windows). Auto-fills the
repo and engineer, times out fast so it can never hang your work, and never
fails the caller. If BEACON_API_KEY isn't set it silently does nothing.

Usage (flags):
  powershell -File send-event.ps1 -Type agent.blocked -Task BCN-42 -Reason "..." -Summary "..." -Confidence 0.9

Usage (full JSON body):
  powershell -File send-event.ps1 -Json '{"type":"agent.heartbeat","summary":"..."}'

Config is resolved in this order, so the helper works standalone with no env:
  key: $env:BEACON_API_KEY, else ~/.beacon/key
  url: $env:BEACON_URL,     else ~/.beacon/url, else the public default
If ~/.beacon/disabled exists, the user opted out - do nothing, ever.

Never put secrets, tokens, or file contents in any field.
#>
param(
  [string]$Type,
  [string]$Task,
  [string]$Summary,
  [string]$Reason,
  [string]$Confidence,
  [string]$Engineer,
  [string]$Repo,
  [string]$Json
)

$ErrorActionPreference = 'SilentlyContinue'

$beaconDir = Join-Path $HOME '.beacon'
if (Test-Path (Join-Path $beaconDir 'disabled')) { exit 0 }

$apiKey = $env:BEACON_API_KEY
if (-not $apiKey) {
  $keyFile = Join-Path $beaconDir 'key'
  if (Test-Path $keyFile) { $apiKey = (Get-Content $keyFile -Raw).Trim() }
}
if (-not $apiKey) { exit 0 }

$baseUrl = $env:BEACON_URL
if (-not $baseUrl) {
  $urlFile = Join-Path $beaconDir 'url'
  if (Test-Path $urlFile) { $baseUrl = (Get-Content $urlFile -Raw).Trim() }
}
if (-not $baseUrl) { $baseUrl = 'https://beacon-tool.vercel.app' }
$baseUrl = $baseUrl.TrimEnd('/')

if (-not $Repo) {
  $url = (git remote get-url origin 2>$null)
  if ($url) {
    $url = $url -replace '\.git$', ''
    $Repo = (Split-Path (Split-Path $url -Parent) -Leaf) + '/' + (Split-Path $url -Leaf)
  }
  else {
    $top = (git rev-parse --show-toplevel 2>$null)
    if (-not $top) { $top = (Get-Location).Path }
    $Repo = Split-Path $top -Leaf
  }
}
if (-not $Engineer) {
  $Engineer = (git config user.name 2>$null)
  if (-not $Engineer) { $Engineer = (git config user.email 2>$null) }
}

if ($Json) {
  $body = $Json
}
else {
  if (-not $Type) { exit 0 }
  $obj = @{ type = $Type }
  if ($Task) { $obj.task = $Task }
  if ($Engineer) { $obj.engineer = $Engineer }
  if ($Summary) { $obj.summary = $Summary }
  if ($Reason) { $obj.reason = $Reason }
  if ($Repo) { $obj.repo = $Repo }
  $c = 0.0
  if ($Confidence -and [double]::TryParse($Confidence, [ref]$c)) { $obj.confidence = $c }
  $body = $obj | ConvertTo-Json -Compress
}

try {
  Invoke-RestMethod -Method Post -Uri "$baseUrl/api/events" -TimeoutSec 5 `
    -Headers @{ Authorization = "Bearer $apiKey" } `
    -ContentType 'application/json' -Body $body | Out-Null
}
catch {}
exit 0
