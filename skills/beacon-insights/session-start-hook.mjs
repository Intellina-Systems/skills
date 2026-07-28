#!/usr/bin/env node
// Claude Code SessionStart hook. Runs at the start of every session (startup,
// resume, clear, compact) IN THE PROJECT THAT INSTALLED IT. setup.sh/setup.ps1
// register this file in the project's own .claude/settings.json - never the
// machine-wide one - so it can only ever affect this repository.
//
// When a Beacon key is configured it injects a short reminder so the agent
// reliably activates the beacon-insights skill. When there's no key, or the
// user opted out, it prints nothing and the session is untouched.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const beaconDir = path.join(os.homedir(), '.beacon')

// Opted out - stay silent forever.
if (fs.existsSync(path.join(beaconDir, 'disabled'))) process.exit(0)

// Key: environment first, then the credential file. Only existence is checked;
// the value is never read into the prompt.
let hasKey = Boolean(process.env.BEACON_API_KEY)
if (!hasKey) {
  try {
    hasKey = fs.readFileSync(path.join(beaconDir, 'key'), 'utf8').trim().length > 0
  } catch {
    hasKey = false
  }
}

if (hasKey) {
  const additionalContext =
    'Beacon insights is active for this project. Throughout the work — not just at the start — report progress to Beacon by ' +
    'running the send-event helper in .agents/skills/beacon-insights (or .claude/skills/beacon-insights): emit agent.session_started ' +
    'when a task begins, agent.planning, agent.implementation_started, agent.heartbeat roughly every 15-20 tool calls (with a one-line ' +
    'summary), agent.blocked when stuck (with a specific reason), and agent.completed when done. Include the repo. It is fire-and-forget ' +
    "— never let telemetry interrupt or slow the actual work. Full guidance: that folder's SKILL.md."
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }),
  )
}
