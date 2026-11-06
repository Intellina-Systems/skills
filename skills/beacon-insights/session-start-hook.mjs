#!/usr/bin/env node
// Claude Code SessionStart hook. Runs at the start of every session (startup,
// resume, clear, compact) IN THE PROJECT THAT INSTALLED IT. setup.sh/setup.ps1
// register this file in the project's own .claude/settings.json - never the
// machine-wide one - so it can only ever affect this repository.
//
// Two jobs, in order:
//   1. Queue `agent.session_started` itself (the outbox sends it in the
//      background — see beacon-outbox.mjs). This used to be a text reminder
//      asking the model to send it — the least reliable event in the whole
//      skill, because it depended on the model acting on a reminder before
//      doing anything else. Sending it here means it happens whether or not
//      the model ever reads the reminder.
//   2. Inject a short reminder covering what hooks can't do — the semantic
//      events (planning, completed) — since
//      those still need the model. Presence/heartbeat no longer does.
//
// When there's no key, or the user opted out, this does nothing at all.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasKey, isDisabled, getGitInfo, pruneOldState, cap } from './beacon-client.mjs'
import { kickFlush, queueEvent } from './beacon-outbox.mjs'
import { resolveSignature } from './agent-signature.mjs'

// Where this skill is actually installed — the helpers sit next to this file.
// The reminder below used to name a fixed path (~/.claude/skills/...) that a
// project-scoped install never creates, so agents ran a command that could not
// exist, hid the error as told ("fire-and-forget"), and their planning and
// completed updates were silently lost. Naming the real path ends that.
const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url))

/** Forward slashes: Git Bash on Windows reads them, and nothing else breaks. */
function shellPath(p) {
  return p.replace(/\\/g, '/')
}

function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return {}
  }
}

async function main() {
  if (isDisabled()) return
  if (!hasKey()) return

  const input = readStdinJson()
  const cwd = input.cwd || process.cwd()
  const sessionId = input.session_id || ''
  const trigger = input.source || 'startup' // startup | resume | clear | compact — SessionStart's own field is called `source`, distinct from the event's `source` (ingestion channel) below

  pruneOldState()

  const { repo, engineer, task } = getGitInfo(cwd)
  if (sessionId) {
    queueEvent({
      type: 'agent.session_started',
      source: 'agent',
      repo: cap(repo, 200),
      engineer: cap(engineer, 128),
      task,
      sessionId,
      instrumentation: 'hook',
      skillVersion: '3',
      summary: trigger === 'resume' ? 'Resumed work on the task' : 'Started working on the task',
      // On a cold `startup` the transcript has no assistant turn yet, so
      // `model` is usually absent here and arrives with the first heartbeat
      // instead; `resume` and `compact` resolve it straight away. The harness
      // is environment-derived and so is always known.
      ...resolveSignature({ input, sessionId }),
      externalId: `bcn:${sessionId}:session-start`,
    })
  }

  // Anything still queued from an earlier session gets another chance now.
  kickFlush()

  // The literal invocation belongs here, not only in SKILL.md. This text is the
  // one channel guaranteed to reach the agent every session; SKILL.md only
  // arrives if the agent chooses to load the skill.
  const bashHelper = path.join(SKILL_DIR, 'send-event.sh')
  const psHelper = path.join(SKILL_DIR, 'send-event.ps1')
  const howToSend = existsSync(bashHelper)
    ? `  bash "${shellPath(bashHelper)}" --type agent.planning --plan-task PLAN_TASK_ID --summary "plain-language outcome"\n` +
      `  (Windows PowerShell: powershell -File "${psHelper}" -Type agent.planning -Summary "...")\n`
    : '  the Beacon MCP send_event tool (the helper scripts are missing from this install)\n'

  const additionalContext =
    'Beacon insights (V3) is active for this project. Presence and activity are reported automatically by hooks — you do not need to run anything for the dashboard to show this session is live. ' +
    'Start by calling the Beacon MCP get_plan_context tool. If there is no plan today, ask the user what they want to get done, turn their answer into a concise checklist, and add it with add_plan_tasks. Keep the returned plan task id with related progress events; offline tasks need no progress. ' +
    'What hooks cannot see is *why* — two moments still need you to say something, each time it genuinely happens, with no fixed cadence to track:\n' +
    '  - agent.planning, once you have formed a plan\n' +
    '  - agent.completed, once the task is verified done\n' +
    'Send these with this exact command (the path is where the helper is installed on this machine) — not with the Beacon MCP send_event tool, which loses the update if the connection drops and cannot report this skill\'s version; use the Beacon MCP connection for the plan only:\n' +
    howToSend +
    'The helper queues the update and returns immediately; a background process delivers it and retries if the network fails, so it never slows the work. ' +
    'Do not redirect its output to /dev/null or append "|| true" — it is silent when all is well, and anything it prints is a real problem worth one sentence to the user. ' +
    'Every summary must explain the outcome to a non-technical reader; never mention filenames, commands, tools, symbols, or edited-file counts. ' +
    'If a genuinely noteworthy thing happens that neither covers, agent.heartbeat with a one-line summary is fine too — only when there is something worth saying. ' +
    `Full guidance: ${shellPath(path.join(SKILL_DIR, 'SKILL.md'))}.`

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }),
  )
}

await main().catch(() => {}) // a hook must never fail the session it's starting
