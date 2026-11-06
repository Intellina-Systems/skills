// End-to-end tests for Beacon Insights V3, against a local mock Beacon.
// Every test gets a throwaway HOME, so the real ~/.beacon is never touched,
// and nothing reaches the real Beacon.
//
//   node tests/beacon-insights.test.mjs [skillDir]
//
// Covers: queue + background delivery, retry after 503 / timeout / offline,
// one bad event in a batch, rejected key, two senders at once (no duplicates),
// the sender lock, the Claude Code hooks (real helper path, end-of-turn note),
// and both helpers with and without Node. Needs Node 18+; the bash and
// PowerShell cases need Git Bash / PowerShell on Windows.

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SKILL = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'beacon-insights'))
const OUTBOX_JS = path.join(SKILL, 'beacon-outbox.mjs')
let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- mock Beacon
const mock = { mode: '201', delayMs: 0, received: [], badType: 'agent.bad' }
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    if (mock.delayMs) await sleep(mock.delayMs)
    let parsed = null
    try {
      parsed = JSON.parse(body)
    } catch {}
    const events = parsed?.events ?? (parsed ? [parsed] : [])
    const auth = req.headers.authorization
    if (auth !== 'Bearer bcn_test') return res.writeHead(500).end('test harness: wrong key forwarded')
    if (mock.mode === '503') return res.writeHead(503).end('busy')
    if (mock.mode === '401') return res.writeHead(401).end('bad key')
    if (events.some((e) => e.type === mock.badType)) return res.writeHead(400).end('{"error":"Invalid event payload"}')
    mock.received.push(...events)
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ inserted: events.length }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bcn-v3-'))
  return home
}
function envFor(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    BEACON_API_KEY: 'bcn_test',
    BEACON_URL: `http://127.0.0.1:${PORT}`,
    BEACON_SEND_TIMEOUT_MS: '1500',
    CLAUDE_CODE_SESSION_ID: '',
    ...extra,
  }
}
const outboxOf = (home) => path.join(home, '.beacon', 'outbox')
const queued = (home) => {
  try {
    return fs.readdirSync(outboxOf(home)).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
}
const failed = (home) => {
  try {
    return fs.readdirSync(path.join(outboxOf(home), 'failed'))
  } catch {
    return []
  }
}
const errorsLog = (home) => {
  try {
    return fs.readFileSync(path.join(home, '.beacon', 'errors.log'), 'utf8')
  } catch {
    return ''
  }
}
async function waitFor(fn, ms = 10000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (fn()) return true
    await sleep(100)
  }
  return fn()
}
function run(cmd, args, { home, input, extraEnv } = {}) {
  const t = Date.now()
  const r = spawnSync(cmd, args, { input, env: envFor(home, extraEnv), encoding: 'utf8', cwd: SKILL })
  return { ...r, ms: Date.now() - t }
}
function makeAllDue(home) {
  for (const n of queued(home)) {
    const f = path.join(outboxOf(home), n)
    const e = JSON.parse(fs.readFileSync(f, 'utf8'))
    e.nextAttemptAt = 0
    fs.writeFileSync(f, JSON.stringify(e))
  }
}
const lockOf = (home) => path.join(outboxOf(home), '.sender.lock')
// Async, never spawnSync: the mock Beacon lives in this process, and blocking
// the event loop would stop it answering. Waits for any background sender first.
async function flushNow(home, extraEnv) {
  await waitFor(() => !fs.existsSync(lockOf(home)), 15000)
  const child = spawn(process.execPath, [OUTBOX_JS, 'flush'], { env: envFor(home, extraEnv), stdio: 'ignore' })
  await new Promise((r) => child.on('exit', r))
}

// ------------------------------------------------------------------- 1. happy
{
  const home = freshHome()
  mock.mode = '201'
  mock.received = []
  const r = run(process.execPath, [OUTBOX_JS, 'enqueue'], {
    home,
    input: JSON.stringify({ type: 'agent.planning', summary: 'Plan', skillVersion: '3' }),
  })
  check('enqueue returns quickly (< 1.5s, includes node startup)', r.ms < 1500, r.ms)
  const delivered = await waitFor(() => mock.received.length === 1 && queued(home).length === 0)
  check('background sender delivers and empties the outbox', delivered, { got: mock.received.length, left: queued(home) })
  const ev = mock.received[0] ?? {}
  check('event carries externalId, occurredAt, skillVersion 3', !!ev.externalId && !!ev.occurredAt && ev.skillVersion === '3', ev)
}

// ---------------------------------------------- 2. 503, then recovers on retry
{
  const home = freshHome()
  mock.mode = '503'
  mock.received = []
  run(process.execPath, [OUTBOX_JS, 'enqueue'], { home, input: JSON.stringify({ type: 'agent.completed', summary: 'Done' }) })
  await waitFor(() => errorsLog(home).includes('HTTP 503'))
  const files = queued(home)
  const entry = files[0] ? JSON.parse(fs.readFileSync(path.join(outboxOf(home), files[0]), 'utf8')) : {}
  check('a 503 puts the event back in the outbox', files.length === 1, files)
  check('…with attempts=1 and a future retry time', entry.attempts === 1 && entry.nextAttemptAt > Date.now(), entry)
  check('…and a failure log line naming the file and retry time', /attempt 1, saved in outbox, retrying after/.test(errorsLog(home)), errorsLog(home))
  const firstId = entry.event?.externalId
  await flushNow(home)
  check('not retried before its retry time', queued(home).length === 1 && mock.received.length === 0)
  mock.mode = '201'
  makeAllDue(home)
  await flushNow(home)
  check('retried once due, delivered, removed', queued(home).length === 0 && mock.received.length === 1)
  check('the retry keeps the same externalId (server de-dupes)', mock.received[0]?.externalId === firstId)
}

// ------------------------------------------------------------- 3. timeout
{
  const home = freshHome()
  mock.mode = '201'
  mock.delayMs = 3000 // > BEACON_SEND_TIMEOUT_MS 1500
  mock.received = []
  run(process.execPath, [OUTBOX_JS, 'enqueue'], { home, input: JSON.stringify({ type: 'agent.heartbeat' }) })
  await waitFor(() => errorsLog(home).includes('timed out'), 8000)
  check('a timed-out send is requeued, logged as timed out', queued(home).length === 1 && errorsLog(home).includes('timed out'), errorsLog(home))
  mock.delayMs = 0
  await sleep(3500) // let the slow mock finish recording the late arrival
}

// -------------------------------------------------------------- 4. offline
{
  const home = freshHome()
  const r = spawnSync(process.execPath, [OUTBOX_JS, 'enqueue'], {
    input: JSON.stringify({ type: 'agent.heartbeat' }),
    env: envFor(home, { BEACON_URL: 'http://127.0.0.1:9' }),
    encoding: 'utf8',
  })
  await waitFor(() => errorsLog(home).includes('could not reach Beacon'), 8000)
  check('offline: queued, logged as could not reach', r.status === 0 && queued(home).length === 1 && errorsLog(home).includes('could not reach Beacon'), errorsLog(home))
}

// ----------------------------- 5. one bad event in a batch doesn't sink others
{
  const home = freshHome()
  mock.mode = '201'
  mock.received = []
  run(process.execPath, [OUTBOX_JS, 'enqueue'], {
    home,
    input: JSON.stringify({ events: [{ type: 'agent.heartbeat', summary: 'a' }, { type: mock.badType, summary: 'bad' }, { type: 'agent.heartbeat', summary: 'c' }] }),
  })
  await waitFor(() => queued(home).length === 0 && failed(home).length === 1)
  check('good events in a refused batch are delivered', mock.received.length === 2, mock.received.map((e) => e.summary))
  check('the bad one is set aside in failed/', failed(home).length === 1)
  check('…and logged in full for replay', errorsLog(home).includes('NOT retried') && errorsLog(home).includes('"summary":"bad"'), errorsLog(home))
}

// ---------------------------------------------------------- 6. rejected key
{
  const home = freshHome()
  mock.mode = '401'
  run(process.execPath, [OUTBOX_JS, 'enqueue'], { home, input: JSON.stringify({ type: 'agent.heartbeat' }) })
  await waitFor(() => errorsLog(home).includes('rejected the API key'))
  const files = queued(home)
  const entry = files[0] ? JSON.parse(fs.readFileSync(path.join(outboxOf(home), files[0]), 'utf8')) : {}
  check('401 keeps the event queued', files.length === 1)
  check('…retried slowly (>= ~30 min)', entry.nextAttemptAt - Date.now() > 25 * 60_000, entry.nextAttemptAt - Date.now())
  const status = run(process.execPath, [OUTBOX_JS, 'status'], { home })
  check('status reports the rejected key', /key rejected: yes/.test(status.stdout), status.stdout)
  mock.mode = '201'
}

// ------------------------------------- 7. two senders at once: no duplicates
{
  const home = freshHome()
  mock.mode = '201'
  mock.delayMs = 200
  mock.received = []
  const events = Array.from({ length: 150 }, (_, i) => ({ type: 'agent.heartbeat', summary: `e${i}` }))
  // queue without kicking a sender, so the two below race on the same files
  for (const chunk of [events.slice(0, 75), events.slice(75)]) {
    spawnSync(process.execPath, ['-e', `import(${JSON.stringify('file:///' + OUTBOX_JS.replace(/\\/g, '/'))}).then(m => m.enqueue(${JSON.stringify({ events: chunk })}))`], {
      env: envFor(home),
      encoding: 'utf8',
    })
  }
  check('150 events queued', queued(home).length === 150, queued(home).length)
  const a = spawn(process.execPath, [OUTBOX_JS, 'flush'], { env: envFor(home), stdio: 'ignore' })
  const b = spawn(process.execPath, [OUTBOX_JS, 'flush'], { env: envFor(home), stdio: 'ignore' })
  await Promise.all([new Promise((r) => a.on('exit', r)), new Promise((r) => b.on('exit', r))])
  const ids = mock.received.map((e) => e.externalId)
  check('two concurrent senders deliver all 150', ids.length >= 150 && queued(home).length === 0, { received: ids.length, left: queued(home).length })
  check('…each exactly once', new Set(ids).size === ids.length, ids.length - new Set(ids).size)
  mock.delayMs = 0
}

// --------------------------------- 8. the one-sender lock: live vs. stale
{
  const home = freshHome()
  mock.mode = '201'
  mock.received = []
  const ob = outboxOf(home)
  fs.mkdirSync(path.join(ob, 'failed'), { recursive: true })
  const entry = { v: 1, id: 'x1', queuedAt: Date.now(), attempts: 0, nextAttemptAt: 0, lastError: null, event: { type: 'agent.heartbeat', externalId: 'bcn:test:locked' } }
  fs.writeFileSync(path.join(ob, 'x1.json'), JSON.stringify(entry))
  fs.writeFileSync(lockOf(home), JSON.stringify({ pid: 1, at: Date.now() }))
  {
    const child = spawn(process.execPath, [OUTBOX_JS, 'flush'], { env: envFor(home), stdio: 'ignore' })
    await new Promise((r) => child.on('exit', r))
  }
  check('a sender gives way while another holds the lock', mock.received.length === 0 && queued(home).length === 1)
  const old = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(lockOf(home), old, old)
  {
    const child = spawn(process.execPath, [OUTBOX_JS, 'flush'], { env: envFor(home), stdio: 'ignore' })
    await new Promise((r) => child.on('exit', r))
  }
  check('a stale lock from a dead sender is cleared and the queue delivered', mock.received.some((e) => e.externalId === 'bcn:test:locked') && queued(home).length === 0)
  check('…and the lock is released afterwards', !fs.existsSync(lockOf(home)))
}

// --------------------------------------------------------- 9. Claude Code hooks
{
  const home = freshHome()
  mock.mode = '201'
  mock.received = []
  const repo = SKILL // any git checkout works for git lookups
  const ss = run(process.execPath, [path.join(SKILL, 'session-start-hook.mjs')], {
    home,
    input: JSON.stringify({ session_id: 'sess-1', cwd: repo, source: 'startup' }),
  })
  check('session-start hook returns quickly (< 2s)', ss.ms < 2000, ss.ms)
  let ctx = ''
  try {
    ctx = JSON.parse(ss.stdout).hookSpecificOutput.additionalContext
  } catch {}
  const expected = path.join(SKILL, 'send-event.sh').replace(/\\/g, '/')
  check('session-start names the helper at its real path', ctx.includes(`bash "${expected}"`), ctx.slice(0, 400))
  check('session-start no longer names ~/.claude/skills', !ctx.includes('~/.claude/skills'))
  check('session-start no longer warns at the start of work', !/failed locally/.test(ctx))
  await waitFor(() => mock.received.some((e) => e.type === 'agent.session_started'))
  const started = mock.received.find((e) => e.type === 'agent.session_started')
  check('session_started delivered in the background, skillVersion 3', started?.skillVersion === '3', started)

  for (let i = 0; i < 18; i++) {
    run(process.execPath, [path.join(SKILL, 'beacon-hook.mjs'), 'tool'], {
      home,
      input: JSON.stringify({ session_id: 'sess-1', cwd: repo, tool_name: 'Edit', tool_input: { file_path: `/x/f${i}.ts` } }),
    })
  }
  await waitFor(() => mock.received.some((e) => e.type === 'agent.heartbeat'))
  check('18 edits produce one heartbeat, delivered in the background', mock.received.filter((e) => e.type === 'agent.heartbeat').length === 1)

  // Stuck updates → one note at the end of the turn, not repeated.
  mock.mode = '503'
  run(process.execPath, [OUTBOX_JS, 'enqueue'], { home, input: JSON.stringify({ type: 'agent.completed' }) })
  await waitFor(() => errorsLog(home).includes('HTTP 503'))
  for (const n of queued(home)) {
    const f = path.join(outboxOf(home), n)
    const e = JSON.parse(fs.readFileSync(f, 'utf8'))
    e.queuedAt = Date.now() - 15 * 60_000 // failing for 15 minutes now
    fs.writeFileSync(f, JSON.stringify(e))
  }
  const stop1 = run(process.execPath, [path.join(SKILL, 'beacon-hook.mjs'), 'stop'], { home, input: JSON.stringify({ session_id: 'sess-1', cwd: repo }) })
  let msg = ''
  try {
    msg = JSON.parse(stop1.stdout).systemMessage
  } catch {}
  check('end of turn shows one plain-language note about stuck updates', /could not be delivered yet/.test(msg) && /keep retrying/.test(msg), stop1.stdout)
  const stop2 = run(process.execPath, [path.join(SKILL, 'beacon-hook.mjs'), 'stop'], { home, input: JSON.stringify({ session_id: 'sess-1', cwd: repo }) })
  check('…and does not repeat it on the next turn', stop2.stdout.trim() === '', stop2.stdout)
  const toolOut = run(process.execPath, [path.join(SKILL, 'beacon-hook.mjs'), 'tool'], {
    home,
    input: JSON.stringify({ session_id: 'sess-1', cwd: repo, tool_name: 'Edit', tool_input: { file_path: '/x/y.ts' } }),
  })
  check('mid-work hooks never print anything', toolOut.stdout.trim() === '', toolOut.stdout)
  mock.mode = '201'

  const end = run(process.execPath, [path.join(SKILL, 'beacon-hook.mjs'), 'session-end'], { home, input: JSON.stringify({ session_id: 'sess-1', cwd: repo, reason: 'other' }) })
  check('session-end hook returns quickly (< 2s)', end.ms < 2000, end.ms)
  await waitFor(() => mock.received.some((e) => e.type === 'agent.session_ended'))
  check('session_ended delivered in the background', mock.received.some((e) => e.type === 'agent.session_ended'))
}

// --------------------------------------------------- 10. bash helper, with Node
// BASH_PATH overrides where Git Bash lives on a Windows machine that installed it elsewhere.
const bash = process.env.BASH_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash')
{
  const home = freshHome()
  mock.mode = '201'
  mock.received = []
  const r = run(bash, [path.join(SKILL, 'send-event.sh').replace(/\\/g, '/'), '--type', 'agent.planning', '--summary', 'Plan via bash'], { home })
  check('send-event.sh (Node available) prints nothing and returns quickly', r.stdout.trim() === '' && r.stderr.trim() === '' && r.ms < 3000, { ms: r.ms, out: r.stdout, err: r.stderr })
  await waitFor(() => mock.received.some((e) => e.summary === 'Plan via bash'))
  const ev = mock.received.find((e) => e.summary === 'Plan via bash')
  check('…delivered in the background with skillVersion 3 and model instrumentation', ev?.skillVersion === '3' && ev?.instrumentation === 'model', ev)

  // json_escape must work on BSD/macOS sed too, not only GNU: a summary with a
  // newline, quote, backslash and tab still arrives as valid JSON, unchanged.
  const tricky = 'Line one "quoted"\nLine two with a \\ and a\ttab'
  const r2 = run(bash, [path.join(SKILL, 'send-event.sh').replace(/\\/g, '/'), '--type', 'agent.completed', '--summary', tricky], { home })
  check('send-event.sh escapes a multi-line summary silently', r2.stdout.trim() === '' && r2.stderr.trim() === '', { out: r2.stdout, err: r2.stderr })
  await waitFor(() => mock.received.some((e) => e.summary === tricky))
  check('…and it arrives unchanged', mock.received.some((e) => e.summary === tricky), mock.received.map((e) => e.summary))
}

// --------------------------------------------- 11. bash helper, without Node
{
  const home = freshHome()
  mock.mode = '503'
  mock.received = []
  // PATH with git/coreutils but no node
  const gitUsr = 'C:\\Program Files\\Git\\usr\\bin'
  const noNodePath = process.platform === 'win32' ? `${gitUsr};C:\\Program Files\\Git\\bin;C:\\Windows\\System32` : '/usr/bin:/bin'
  run(bash, ['-c', `command -v node >/dev/null && echo HAS_NODE || echo NO_NODE`], { home, extraEnv: { PATH: noNodePath } })
  const probe = spawnSync(bash, ['-c', 'command -v node >/dev/null && echo HAS_NODE || echo NO_NODE'], { env: envFor(home, { PATH: noNodePath }), encoding: 'utf8' })
  check('no-Node test really has no node on PATH', probe.stdout.trim() === 'NO_NODE', probe.stdout)
  const r = spawnSync(bash, [path.join(SKILL, 'send-event.sh').replace(/\\/g, '/'), 'agent.completed', 'Done without node'], {
    env: envFor(home, { PATH: noNodePath }),
    encoding: 'utf8',
  })
  await waitFor(() => errorsLog(home).includes('Done without node'), 10000)
  check('no Node + 503: the event file stays queued', queued(home).length === 1, queued(home))
  check('…and the failure log has the full event for replay', /HTTP 503 sending agent.completed .*saved in outbox/.test(errorsLog(home)), errorsLog(home))
  mock.mode = '201'
  makeAllDue(home)
  await flushNow(home) // the next Node sender on this machine picks it up
  check('…and the Node sender later delivers it', queued(home).length === 0 && mock.received.some((e) => e.summary === 'Done without node'))
  check('the bash-written file was valid for the Node sender', r.status === 0)
}

// ------------------------------------------------ 12. PowerShell helper, Node
if (process.platform === 'win32') {
  const home = freshHome()
  mock.mode = '201'
  mock.received = []
  const r = run('powershell', ['-NoProfile', '-File', path.join(SKILL, 'send-event.ps1'), '-Type', 'agent.planning', '-Summary', 'Plan via ps'], { home })
  check('send-event.ps1 prints nothing', r.stdout.trim() === '' && r.stderr.trim() === '', { out: r.stdout, err: r.stderr })
  await waitFor(() => mock.received.some((e) => e.summary === 'Plan via ps'))
  const ev = mock.received.find((e) => e.summary === 'Plan via ps')
  check('…delivered with skillVersion 3, externalId and occurredAt', ev?.skillVersion === '3' && !!ev?.externalId && !!ev?.occurredAt, ev)
}

// Async, for anything that talks to the mock while it runs: spawnSync would
// freeze this process, and with it the mock's ability to answer.
function runAsync(cmd, args, { home, extraEnv } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: envFor(home, extraEnv), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('exit', (status) => resolve({ status, stdout, stderr }))
  })
}

// --------------------------------------- 13. PowerShell helper, without Node
if (process.platform === 'win32') {
  const noNodePath = 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Program Files\\Git\\cmd'
  {
    const home = freshHome()
    mock.mode = '201'
    mock.received = []
    const r = await runAsync('powershell', ['-NoProfile', '-File', path.join(SKILL, 'send-event.ps1'), '-Type', 'agent.completed', '-Summary', 'PS no node ok'], {
      home,
      extraEnv: { PATH: noNodePath },
    })
    check('ps1 without Node: delivers directly', r.status === 0 && mock.received.some((e) => e.summary === 'PS no node ok'), { status: r.status, err: r.stderr })
    check('…and removes its outbox file', queued(home).length === 0, queued(home))
  }
  {
    const home = freshHome()
    mock.mode = '503'
    mock.received = []
    await runAsync('powershell', ['-NoProfile', '-File', path.join(SKILL, 'send-event.ps1'), '-Type', 'agent.completed', '-Summary', 'PS no node 503'], {
      home,
      extraEnv: { PATH: noNodePath },
    })
    check('ps1 without Node + 503: the update stays queued', queued(home).length === 1, queued(home))
    check('…and is logged in full for replay', /saved in outbox.*PS no node 503/.test(errorsLog(home)), errorsLog(home))
    mock.mode = '201'
    makeAllDue(home)
    await flushNow(home)
    check('…and the Node sender later delivers it', queued(home).length === 0 && mock.received.some((e) => e.summary === 'PS no node 503'))
  }
}

// -------------------------------------------------- 14. give up after 7 days
{
  const home = freshHome()
  mock.mode = '503'
  mock.received = []
  const ob = outboxOf(home)
  fs.mkdirSync(path.join(ob, 'failed'), { recursive: true })
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60_000
  fs.writeFileSync(
    path.join(ob, 'old.json'),
    JSON.stringify({ v: 1, id: 'old', queuedAt: eightDaysAgo, attempts: 12, nextAttemptAt: 0, lastError: 'HTTP 503', event: { type: 'agent.heartbeat', externalId: 'bcn:test:old', summary: 'ancient' } }),
  )
  await flushNow(home)
  check('an update still failing after 7 days is set aside, not retried forever', queued(home).length === 0 && failed(home).includes('old.json'), { queued: queued(home), failed: failed(home) })
  check('…and the log says so, with the full event', /gave up after 7 days.*"summary":"ancient"/.test(errorsLog(home)), errorsLog(home))
  mock.mode = '201'
}

// --------------------------- 15. retries get another chance while work goes on
{
  const home = freshHome()
  mock.mode = '201'
  mock.received = []
  const ob = outboxOf(home)
  fs.mkdirSync(path.join(ob, 'failed'), { recursive: true })
  const due = { v: 1, id: 'due', queuedAt: Date.now() - 60_000, attempts: 1, nextAttemptAt: 0, lastError: 'HTTP 503', event: { type: 'agent.heartbeat', externalId: 'bcn:test:due' } }
  fs.writeFileSync(path.join(ob, 'due.json'), JSON.stringify(due))
  // A sender was started moments ago: an ordinary edit must not start another.
  fs.writeFileSync(path.join(ob, '.last-kick'), String(Date.now()))
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SKILL, 'beacon-hook.mjs'), 'tool'], { env: envFor(home), stdio: ['pipe', 'ignore', 'ignore'] })
    child.stdin.end(JSON.stringify({ session_id: 'sess-k', cwd: SKILL, tool_name: 'Edit', tool_input: { file_path: '/x/a.ts' } }))
    child.on('exit', resolve)
  })
  await sleep(1500)
  check('within a minute of the last sender, an edit does not start another', mock.received.length === 0 && queued(home).length === 1)
  // A minute later, the next edit gives the due retry its chance.
  fs.writeFileSync(path.join(ob, '.last-kick'), String(Date.now() - 2 * 60_000))
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SKILL, 'beacon-hook.mjs'), 'tool'], { env: envFor(home), stdio: ['pipe', 'ignore', 'ignore'] })
    child.stdin.end(JSON.stringify({ session_id: 'sess-k', cwd: SKILL, tool_name: 'Edit', tool_input: { file_path: '/x/b.ts' } }))
    child.on('exit', resolve)
  })
  await waitFor(() => mock.received.some((e) => e.externalId === 'bcn:test:due'))
  check('after that, an ordinary edit starts a sender and the due retry is delivered', mock.received.some((e) => e.externalId === 'bcn:test:due') && queued(home).length === 0)
}

// ----------------------------------- 16. every install is a fresh install
{
  const FRESH_JS = path.join(SKILL, 'fresh-install.mjs')
  const LEGACY =
    '<!-- beacon-insights:auto (managed by skills/beacon-insights/setup.ps1) -->\n' +
    'When BEACON_API_KEY is set … send-event helper in ~/.claude/skills/beacon-insights … Fire-and-forget.\n' +
    '<!-- /beacon-insights:auto -->\n'

  // An old machine-wide note is removed; the user's own text stays.
  const home = freshHome()
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  const userText = '# My own rules\nAlways write tests.\n'
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), `${userText}\n${LEGACY}`)
  fs.writeFileSync(path.join(home, '.codex', 'AGENTS.md'), LEGACY) // nothing but our note
  fs.writeFileSync(path.join(home, '.gemini.md.untouched'), 'x') // unrelated file
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bcn-proj-'))
  const oldDirective =
    '# Project rules\n\n<!-- beacon-insights:project (managed by skills/beacon-insights/setup.sh) -->\n' +
    'This repo uses the beacon-insights skill … Fire-and-forget; never let it interrupt the work.\n' +
    '<!-- /beacon-insights:project -->\n'
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), oldDirective)

  const r1 = run(process.execPath, [FRESH_JS, projectRoot], { home })
  const claude = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')
  check('setup removes an old Beacon note from ~/.claude/CLAUDE.md', !claude.includes('beacon-insights'), claude)
  check("…and keeps the user's own text exactly", claude.trim() === userText.trim(), claude)
  check('a file that held only the old note is removed', !fs.existsSync(path.join(home, '.codex', 'AGENTS.md')))
  check('setup says what it cleaned', /Removed an outdated Beacon note/.test(r1.stdout), r1.stdout)

  run(process.execPath, [FRESH_JS, projectRoot], { home }) // second run: must not duplicate
  const agents = fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf8')
  check('the project directive is replaced with the current text', !agents.includes('Fire-and-forget') && agents.includes('never hide its output'), agents)
  check('…exactly once, however many times setup runs', (agents.match(/<!-- beacon-insights:project\b/g) ?? []).length === 1, agents)
  check("…and the project's own text stays", agents.startsWith('# Project rules'), agents)

  // Hooks are rewritten, not skipped: an old path is replaced, a user's own hook is kept.
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'node "/old/place/beacon-insights/session-start-hook.mjs"' }] }],
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo my-own-hook' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'node "/old/beacon-insights/beacon-hook.mjs" notify' }] }],
      },
    }),
  )
  for (let i = 0; i < 2; i++) run(process.execPath, [path.join(SKILL, 'merge-settings.mjs'), settingsPath, '.agents/skills/beacon-insights'], { home })
  const hooks = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks
  const commands = (event) => (hooks[event] ?? []).flatMap((e) => e.hooks.map((h) => h.command))
  check('an old hook path is replaced by the current one', commands('SessionStart').length === 1 && commands('SessionStart')[0].includes('/.agents/skills/beacon-insights/session-start-hook.mjs'), commands('SessionStart'))
  check("a user's own hook on the same event is kept", commands('PostToolUse').includes('echo my-own-hook'))
  check('…and ours is there exactly once after two runs', commands('PostToolUse').filter((c) => c.includes('beacon-insights')).length === 1, commands('PostToolUse'))
  check('retired hooks are removed', !hooks.Notification)

  // The session-start hook heals a machine on its own.
  const home2 = freshHome()
  fs.mkdirSync(path.join(home2, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home2, '.claude', 'CLAUDE.md'), `${userText}\n${LEGACY}`)
  run(process.execPath, [path.join(SKILL, 'session-start-hook.mjs')], {
    home: home2,
    input: JSON.stringify({ session_id: 'sess-heal', cwd: SKILL, source: 'startup' }),
  })
  const healed = fs.readFileSync(path.join(home2, '.claude', 'CLAUDE.md'), 'utf8')
  check('every session start removes an old Beacon note by itself', !healed.includes('beacon-insights') && healed.trim() === userText.trim(), healed)
}

server.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
