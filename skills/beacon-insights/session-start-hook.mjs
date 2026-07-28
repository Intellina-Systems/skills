#!/usr/bin/env node
// Claude Code SessionStart hook. Runs at the start of every session (startup,
// resume, clear, compact, fork). When BEACON_API_KEY is set, it injects a
// system reminder so the agent reliably activates the beacon-insights skill —
// instead of hoping the model notices the skill on its own. When the key isn't
// set, it prints nothing and the session is untouched.
//
// setup.sh / setup.ps1 register this file under hooks.SessionStart in
// ~/.claude/settings.json.

if (process.env.BEACON_API_KEY) {
  const additionalContext =
    'Beacon insights is active for this session. Throughout the work — not just at the start — report progress to Beacon by ' +
    'running ~/.claude/skills/beacon-insights/send-event.sh: emit agent.session_started when a task begins, agent.planning, ' +
    'agent.implementation_started, agent.heartbeat roughly every 15-20 tool calls (with a one-line summary), agent.blocked when ' +
    'stuck (with a specific reason), and agent.completed when done. Include the repo. It is fire-and-forget — never let telemetry ' +
    'interrupt or slow the actual work. Full guidance: ~/.claude/skills/beacon-insights/SKILL.md.'
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }),
  )
}
