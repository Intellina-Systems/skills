#!/usr/bin/env node
// Consolidated deterministic hook — the reliability floor that doesn't depend
// on the model remembering anything. One file, three Claude Code hook events,
// dispatched by a subcommand argument (see setup.sh/setup.ps1 for how each
// is registered). Every subcommand reads the hook's stdin JSON payload,
// updates a small per-session state file, and — subject to its own
// throttle — queues a derived event in the outbox (beacon-outbox.mjs), which a
// background process sends. The hook itself never waits on the network.
//
// Cadence is deliberately sparse: one session_started, one session_ended, and
// a heartbeat roughly every 15-20 tool calls — counted by this hook, not
// asked of the model, which is the whole point (a counter never forgets).
// Presence pings for routine UI moments (a permission prompt, auto-compaction)
// aren't sent at all — they read as noise on the dashboard, not signal.
//
// Derived means derived: summaries here are assembled from tool metadata and
// git state, never from free-text model output, specifically so this file
// can never leak a code snippet or file content into a heartbeat. The richer,
// model-authored narrative (agent.planning, agent.completed) is a
// separate, complementary path — see SKILL.md — not
// something this script tries to replace.
//
// Usage: node beacon-hook.mjs <tool|stop|session-end>

import { readFileSync } from 'node:fs'
import { hasKey, isDisabled, getGitInfo, readSessionState, writeSessionState, cap } from './beacon-client.mjs'
import { kickFlush, outboxStatus, queueEvent } from './beacon-outbox.mjs'
import { resolveSignature } from './agent-signature.mjs'

const TOOL_CALL_THRESHOLD = 18 // heartbeat every ~15-20 tool calls, counted here instead of by the model

const TEST_COMMAND_RE = /\b(npm (run )?test|pnpm test|yarn test|pytest|go test|cargo test|jest|vitest|mocha|rspec|phpunit)\b/i

function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return {}
  }
}

// Every tool_response shape below is a best-effort guess at fields Claude
// Code's PostToolUse payload might use — hook payload shapes aren't
// guaranteed stable across CLI versions, so this never assumes a field
// exists and always has a path that still produces *a* summary rather than
// silently skipping the event.
function testOutcome(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return null
  const exitCode = toolResponse.exitCode ?? toolResponse.exit_code ?? toolResponse.exitStatus
  if (typeof exitCode === 'number') return exitCode === 0 ? 'pass' : 'fail'
  const text = String(toolResponse.stdout ?? '') + String(toolResponse.stderr ?? '')
  if (/\b(fail|error)ed?\b/i.test(text) && !/\b0 fail/i.test(text)) return 'fail'
  if (text) return 'pass'
  return null
}

function basename(filePath) {
  if (typeof filePath !== 'string') return null
  return filePath.split(/[\\/]/).pop()
}

// Assembled from what actually happened, not asked of the model. This is the
// whole point — a heartbeat this script sends never depends on anyone
// remembering to write a good summary.
function deriveSummary(state) {
  if (state.testResult === 'pass') return 'Checked the work and everything passed'
  if (state.testResult === 'fail') return 'Checks found something that needs attention'
  return 'Making progress on the task'
}

async function loadContext() {
  if (isDisabled() || !hasKey()) return null
  const input = readStdinJson()
  const sessionId = input.session_id || ''
  if (!sessionId) return null // nothing to correlate against — not worth guessing an id
  const cwd = input.cwd || process.cwd()
  const { repo, engineer, task } = getGitInfo(cwd)
  // Resolved once per hook invocation rather than per event — it costs one
  // bounded read of the session transcript, and both event paths below want
  // the same answer.
  const signature = resolveSignature({ input, sessionId })
  return { input, sessionId, cwd, repo, engineer, task, signature, state: readSessionState(sessionId) }
}

// One heartbeat (or test result, if one ran this window) per crossing of the
// threshold. externalId is a per-session sequence number, not a time bucket —
// a retry of the same crossing collapses via dedup; the next real crossing
// always gets a fresh id.
async function flushHeartbeat(ctx) {
  const { sessionId, state } = ctx
  const type =
    state.testResult === 'fail' ? 'agent.tests_failed' : state.testResult === 'pass' ? 'agent.tests_passed' : 'agent.heartbeat'
  state.heartbeatSeq = (state.heartbeatSeq || 0) + 1
  // Queued, not sent. Once it is safely on disk the window resets: delivering
  // it, and retrying if the network fails, is the outbox's job.
  const queued = queueEvent({
    type,
    source: 'agent',
    instrumentation: 'hook',
    skillVersion: '3',
    sessionId,
    repo: cap(ctx.repo, 200),
    engineer: cap(ctx.engineer, 128),
    task: ctx.task,
    summary: cap(deriveSummary(state), 500),
    ...ctx.signature,
    externalId: `bcn:${sessionId}:heartbeat:${state.heartbeatSeq}`,
  })
  if (queued) {
    state.toolCallCount = 0
    state.filesTouched = []
    state.testResult = null
    state.dirty = false
  }
  writeSessionState(sessionId, state)
}

async function handleTool(ctx) {
  const { input, sessionId, state } = ctx
  const toolName = input.tool_name || ''
  if (!/^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/.test(toolName)) return // defensive — matcher already scopes this

  state.filesTouched = state.filesTouched || []
  if (toolName !== 'Bash') {
    const file = basename(input.tool_input?.file_path)
    if (file && !state.filesTouched.includes(file)) state.filesTouched.push(file)
  } else {
    const command = String(input.tool_input?.command || '')
    if (TEST_COMMAND_RE.test(command)) {
      const outcome = testOutcome(input.tool_response)
      if (outcome) state.testResult = outcome
    }
  }
  state.dirty = true
  state.toolCallCount = (state.toolCallCount || 0) + 1

  if (state.toolCallCount < TOOL_CALL_THRESHOLD) {
    writeSessionState(sessionId, state) // accumulate only — not at the threshold yet
    // Anything waiting for a retry gets another chance while work goes on.
    // Throttled inside to at most one background sender a minute, and only
    // when something is actually due, so this costs nothing on most edits.
    kickFlush()
    return
  }
  await flushHeartbeat(ctx)
}

// End of a turn — the agent has finished what it was asked. Two jobs:
//
// 1. Safety net for the heartbeat window: PostToolUse queues the instant the
//    threshold is crossed, so this only fires if that queueing failed and a
//    full window of work is still unreported. It must never fire on every
//    turn — that's the exact flood this replaced.
// 2. The one place a person hears that updates aren't getting through. The
//    end of a turn is when they look up from the work, so a note here is seen
//    without interrupting anything. Shown once per session for a given state
//    of the outbox: a new problem gets a new note, the same one is not
//    repeated every turn.
async function handleStop(ctx) {
  const { input, sessionId, state } = ctx
  if (input.stop_hook_active) return // continuation turn — the original turn's Stop already covers this
  if (state.dirty && (state.toolCallCount || 0) >= TOOL_CALL_THRESHOLD) await flushHeartbeat(ctx)
  kickFlush()

  const warning = deliveryWarning(outboxStatus())
  const signature = warning ?? ''
  if (signature !== (state.lastWarning ?? '')) {
    state.lastWarning = signature
    writeSessionState(sessionId, state)
    if (warning) process.stdout.write(JSON.stringify({ systemMessage: warning }))
  }
}

/** Plain-language note for the person, or null when there is nothing to say. */
function deliveryWarning({ stuck, lastError, failedRecently, keyRejected }) {
  const updates = (n) => `${n} progress update${n === 1 ? '' : 's'}`
  if (keyRejected) {
    return (
      'Beacon: your API key was rejected, so progress updates are not reaching your dashboard. ' +
      'They are saved and will be sent once the key works again: create a new key in Beacon > Settings > API keys and save it to ~/.beacon/key.'
    )
  }
  const parts = []
  if (stuck > 0) {
    parts.push(
      `${updates(stuck)} could not be delivered yet${lastError ? ` (${lastError})` : ''}. ` +
        'They are saved and keep retrying in the background.',
    )
  }
  if (failedRecently > 0) {
    parts.push(
      `${updates(failedRecently)} were refused by Beacon and set aside in ~/.beacon/outbox/failed (details in ~/.beacon/errors.log).`,
    )
  }
  return parts.length > 0 ? `Beacon: ${parts.join(' ')}` : null
}

async function handleSessionEnd(ctx) {
  const { input, sessionId } = ctx
  const reason = input.reason || 'other'
  queueEvent({
    type: 'agent.session_ended',
    source: 'agent',
    instrumentation: 'hook',
    skillVersion: '3',
    sessionId,
    repo: cap(ctx.repo, 200),
    engineer: cap(ctx.engineer, 128),
    task: ctx.task,
    summary: reason === 'clear' ? 'Paused work on the task' : 'Finished this work session',
    ...ctx.signature,
    externalId: `bcn:${sessionId}:session-end`,
  })
}

async function main() {
  const subcommand = process.argv[2]
  const ctx = await loadContext()
  if (!ctx) return

  switch (subcommand) {
    case 'tool':
      return handleTool(ctx)
    case 'stop':
      return handleStop(ctx)
    case 'session-end':
      return handleSessionEnd(ctx)
    default:
      return // unknown subcommand (including retired notify/precompact) — never fail the hook over a config mismatch
  }
}

await main().catch(() => {}) // a hook must never fail the turn it's observing
