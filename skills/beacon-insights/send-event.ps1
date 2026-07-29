<#
Fire-and-forget helper to send a Beacon progress event (Windows). Auto-fills the
repo and engineer, times out fast so it can never hang your work, and never
fails the caller. If BEACON_API_KEY isn't set it silently does nothing.

Usage (positional - the short form most callers reach for):
  powershell -File send-event.ps1 agent.heartbeat "Refactoring session middleware"

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
# PositionalBinding=$false is load-bearing: by default PowerShell binds bare
# words to the named parameters in declaration order, so
# `send-event.ps1 agent.heartbeat "summary"` would put the summary in -Task and
# send a mislabelled event. Turning it off routes bare words to $Rest below,
# where they are interpreted the same way the bash helper interprets them.
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Type,
  [string]$Task,
  [string]$Summary,
  [string]$Reason,
  [string]$Confidence,
  [string]$Engineer,
  [string]$Repo,
  [string]$Json,
  # Catches bare words so `send-event.ps1 agent.heartbeat "summary"` works the
  # same way it does in the bash helper. Without this, PowerShell would bind
  # them positionally to -Type/-Task and silently mislabel the event.
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'SilentlyContinue'

# Bare words: the first is only taken as the type when it *looks* like one
# (dotted lowercase, e.g. agent.heartbeat), so a stray argument becomes a
# summary rather than a bogus event type. Leftovers are dropped, but never in
# silence - an argument quietly discarded here is an event nobody finds out
# was lost.
foreach ($arg in $Rest) {
  if (-not $arg) { continue }
  if ((-not $Type) -and ($arg -cmatch '^[a-z][a-z_]*\.[a-z][a-z_]*$')) { $Type = $arg }
  elseif (-not $Summary) { $Summary = $arg }
  else { [Console]::Error.WriteLine("send-event: ignoring unrecognized argument '$arg'") }
}

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
  # Still exit 0 - telemetry never fails the caller - but say so, or a caller
  # with the wrong syntax gets a clean exit and an empty dashboard forever.
  if (-not $Type) {
    [Console]::Error.WriteLine('send-event: no event type given, nothing sent (try: send-event.ps1 agent.heartbeat "summary")')
    exit 0
  }
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

# Report failures on stderr. A revoked key, a malformed payload, and a working
# send are otherwise indistinguishable - all exit 0 - which is how telemetry
# stays broken for weeks without anyone noticing.
try {
  Invoke-RestMethod -Method Post -Uri "$baseUrl/api/events" -TimeoutSec 5 `
    -Headers @{ Authorization = "Bearer $apiKey" } `
    -ContentType 'application/json' -Body $body -ErrorAction Stop | Out-Null
}
catch {
  $status = $null
  if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  if ($status -eq 401 -or $status -eq 403) {
    [Console]::Error.WriteLine("send-event: Beacon rejected the API key (HTTP $status) - it may have been revoked")
  }
  elseif ($status) {
    [Console]::Error.WriteLine("send-event: Beacon rejected the event (HTTP $status)")
  }
  else {
    [Console]::Error.WriteLine("send-event: could not reach Beacon at $baseUrl (offline or timed out)")
  }
}
exit 0 # always, whatever happened above
