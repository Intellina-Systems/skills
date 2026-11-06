#!/usr/bin/env node
// The outbox: every Beacon event is queued here first and sent in the
// background, so a slow or offline network can never block the agent and a
// failed send is never lost.
//
//   ~/.beacon/outbox/<id>.json          waiting to be sent (or to be retried)
//   ~/.beacon/outbox/.sender.lock       held by the one sender running now
//   ~/.beacon/outbox/failed/<id>.json   the server refused it; kept, not retried
//
// One file per event. Only one sender runs at a time: it takes the lock by
// creating `.sender.lock` exclusively (O_EXCL), which the operating system
// guarantees only one process can win, on every platform. Anyone else who
// tries to send while it runs simply exits — the running sender re-reads the
// queue until nothing is due, so it picks their events up. A sender that dies
// leaves a stale lock, which the next one clears.
//
// (An earlier draft claimed each file by renaming it. On Windows two processes
// can both open a file before either renames it, and both "win" — the same
// events were sent twice. One sender at a time has no such race, and a local
// queue never needs more.)
//
// What happens to a batch:
//   delivered (2xx)                 → the files are deleted
//   network error, timeout, 408,
//   429, 5xx                        → kept in the queue with a later retry time
//   401 / 403 (key rejected)        → kept, retried slowly, so a fixed key
//                                     delivers everything saved
//   any other 4xx                   → the event itself is bad; it goes to
//                                     failed/ (one at a time, so one bad event
//                                     never sinks the good ones in its batch)
//   still undelivered after 7 days  → failed/
//
// Every event gets an `externalId` and its real `occurredAt` when it is
// queued. The server de-duplicates on externalId, so a retry of a send that
// timed out but did arrive is harmless, and a retried event still lands at the
// moment it happened rather than the moment it finally got through.
//
// Usage:
//   node beacon-outbox.mjs flush     send whatever is due (run in the background)
//   node beacon-outbox.mjs enqueue   queue the JSON event (or {events:[…]}) on
//                                    stdin, then start a background sender
//   node beacon-outbox.mjs status    print a summary (for people, not hooks)
//
// Hard rules, same as the rest of the skill: never throw past the caller,
// never block a hook, never print or store the API key.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BEACON_DIR, isDisabled, logFailure, resolveKey, resolveUrl } from './beacon-client.mjs'

export const OUTBOX_DIR = path.join(BEACON_DIR, 'outbox')
export const FAILED_DIR = path.join(OUTBOX_DIR, 'failed')
const LOCK_FILE = path.join(OUTBOX_DIR, '.sender.lock')
const KICK_FILE = path.join(OUTBOX_DIR, '.last-kick')
const AUTH_FLAG = path.join(OUTBOX_DIR, '.key-rejected')

const BATCH_SIZE = 100 // the server's own per-request maximum
// Nobody is waiting on a background send, so it can afford to be patient.
// BEACON_SEND_TIMEOUT_MS exists for tests; there is no reason to set it otherwise.
const SEND_TIMEOUT_MS = Number(process.env.BEACON_SEND_TIMEOUT_MS) || 20_000
const FLUSH_BUDGET_MS = 90_000 // one sender stops starting new batches after this
// A lock older than this belongs to a sender that died: the budget, plus one
// full send timeout, plus margin.
const STALE_LOCK_MS = FLUSH_BUDGET_MS + SEND_TIMEOUT_MS + 40_000
const MAX_AGE_MS = 7 * 24 * 60 * 60_000
const KICK_INTERVAL_MS = 60_000 // without new events, start a sender at most this often
const FAILED_RETENTION_MS = 30 * 24 * 60 * 60_000
const STUCK_AFTER_MS = 10 * 60_000 // retrying this long is worth telling someone about

// Retry delays by attempt number; the last one repeats. Each gets ±20% jitter
// so a whole team coming back online doesn't retry in lockstep.
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 60 * 60_000, 4 * 60 * 60_000, 6 * 60 * 60_000]
const KEY_REJECTED_MIN_DELAY_MS = 30 * 60_000

const HERE = path.dirname(fileURLToPath(import.meta.url))

function backoff(attempts, minimum = 0) {
  const base = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]
  const jittered = base * (0.8 + Math.random() * 0.4)
  return Math.max(Math.round(jittered), minimum)
}

function ensureDirs() {
  fs.mkdirSync(FAILED_DIR, { recursive: true })
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

/** Gives an event what a safe retry needs: a stable id and its real time. */
function normalize(event) {
  const out = { ...event }
  if (!out.externalId) out.externalId = `bcn:q:${randomUUID()}`
  if (!out.occurredAt) out.occurredAt = new Date().toISOString()
  return out
}

/**
 * Queue one event or a `{ events: [...] }` batch. Returns true when it is
 * safely on disk. Synchronous on purpose: it is a small file write, and a hook
 * that has queued its event can exit knowing nothing will be lost.
 */
export function enqueue(input) {
  if (isDisabled()) return false
  try {
    ensureDirs()
    const events = Array.isArray(input?.events) ? input.events : [input]
    for (const event of events) {
      if (!event || typeof event !== 'object' || !event.type) continue
      const id = `${Date.now()}-${randomUUID().slice(0, 8)}`
      const entry = {
        v: 1,
        id,
        queuedAt: Date.now(),
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        event: normalize(event),
      }
      writeAtomic(path.join(OUTBOX_DIR, `${id}.json`), JSON.stringify(entry))
    }
    return true
  } catch (err) {
    logFailure(`could not queue event: ${err?.message ?? 'unknown error'}`)
    return false
  }
}

/**
 * Start a background sender and return immediately. `force` is for when a new
 * event was just queued; otherwise it only starts one if something is due and
 * no sender was started in the last minute, so a hook that fires on every edit
 * doesn't start a process on every edit.
 */
export function kickFlush({ force = false } = {}) {
  if (isDisabled() || !resolveKey()) return
  try {
    if (!force) {
      let last = 0
      try {
        last = Number(fs.readFileSync(KICK_FILE, 'utf8')) || 0
      } catch {
        // never kicked before
      }
      if (Date.now() - last < KICK_INTERVAL_MS) return
      if (!hasDueEntries()) return
    }
    ensureDirs()
    fs.writeFileSync(KICK_FILE, String(Date.now()))
    const child = spawn(process.execPath, [path.join(HERE, 'beacon-outbox.mjs'), 'flush'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    })
    child.unref()
  } catch (err) {
    logFailure(`could not start the background sender: ${err?.message ?? 'unknown error'}`)
  }
}

/** Queue an event and start a background sender. Never waits on the network. */
export function queueEvent(event) {
  const queued = enqueue(event)
  if (queued) kickFlush({ force: true })
  return queued
}

// ---------------------------------------------------------------------------
// Reading the queue
// ---------------------------------------------------------------------------

function listQueued() {
  try {
    return fs.readdirSync(OUTBOX_DIR).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
}

function readEntry(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function hasDueEntries(now = Date.now()) {
  for (const name of listQueued()) {
    const entry = readEntry(path.join(OUTBOX_DIR, name))
    if (entry && (entry.nextAttemptAt || 0) <= now) return true
  }
  return false
}

/** Up to `limit` due entries, oldest first. Unreadable files are set aside. */
function dueEntries(now, limit) {
  const due = []
  for (const name of listQueued()) {
    const file = path.join(OUTBOX_DIR, name)
    const entry = readEntry(file)
    if (!entry || !entry.event) {
      // Corrupt — quarantine it rather than trip over it forever.
      try {
        fs.renameSync(file, path.join(FAILED_DIR, name))
        logFailure(`unreadable outbox entry moved to failed/ (${name})`)
      } catch {
        // gone already
      }
      continue
    }
    if ((entry.nextAttemptAt || 0) <= now) due.push({ name, file, entry })
  }
  due.sort((a, b) => a.entry.queuedAt - b.entry.queuedAt)
  return due.slice(0, limit)
}

function pruneFailed(now) {
  try {
    for (const name of fs.readdirSync(FAILED_DIR)) {
      const file = path.join(FAILED_DIR, name)
      if (now - fs.statSync(file).mtimeMs > FAILED_RETENTION_MS) fs.rmSync(file, { force: true })
    }
  } catch {
    // no failed/ yet
  }
}

// ---------------------------------------------------------------------------
// The one-sender lock
// ---------------------------------------------------------------------------

/** True if this process now holds the lock. Never waits for it. */
function acquireLock(now) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx') // O_CREAT | O_EXCL: exactly one winner
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now }))
      fs.closeSync(fd)
      return true
    } catch (err) {
      if (err?.code !== 'EEXIST') return false
      // Someone holds it. If they have held it impossibly long, they died.
      try {
        if (now - fs.statSync(LOCK_FILE).mtimeMs <= STALE_LOCK_MS) return false
        fs.rmSync(LOCK_FILE, { force: true })
        logFailure('cleared a stale sender lock left by a sender that stopped')
      } catch {
        return false
      }
    }
  }
  return false
}

function releaseLock() {
  try {
    fs.rmSync(LOCK_FILE, { force: true })
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------
// Settling a sent entry
// ---------------------------------------------------------------------------

function describe(entry) {
  return `${entry.event?.type ?? '(event)'} [${entry.event?.externalId ?? entry.id}]`
}

function settleDelivered(item) {
  try {
    fs.rmSync(item.file, { force: true })
  } catch {
    // already gone
  }
}

function settleRetry(item, error, now, minimumDelay = 0) {
  const entry = item.entry
  entry.attempts = (entry.attempts || 0) + 1
  entry.lastError = error
  entry.lastAttemptAt = now

  if (now - entry.queuedAt > MAX_AGE_MS) {
    settleFailed(item, `gave up after 7 days (last error: ${error})`)
    return
  }
  entry.nextAttemptAt = now + backoff(entry.attempts, minimumDelay)
  try {
    writeAtomic(item.file, JSON.stringify(entry))
  } catch {
    // The old file is still there, so it is simply retried sooner.
  }
  logFailure(
    `${error} sending ${describe(entry)} — attempt ${entry.attempts}, saved in outbox, ` +
      `retrying after ${new Date(entry.nextAttemptAt).toISOString()} (outbox/${item.name})`,
  )
}

function settleFailed(item, error) {
  const entry = item.entry
  entry.lastError = error
  entry.failedAt = Date.now()
  try {
    writeAtomic(path.join(FAILED_DIR, item.name), JSON.stringify(entry))
    fs.rmSync(item.file, { force: true })
  } catch {
    // Left in the queue; set aside on a later pass.
  }
  // The full event goes in the log too: this is the one that will not be
  // retried, so the log line has to be enough to replay it by hand.
  logFailure(`${error} — NOT retried, moved to outbox/failed/${item.name}: ${JSON.stringify(entry.event)}`)
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function post(events, key, url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
  try {
    const body = events.length === 1 ? events[0] : { events }
    const res = await fetch(`${url}/api/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    let detail = ''
    if (!res.ok) {
      try {
        detail = (await res.text()).slice(0, 300)
      } catch {
        // no body
      }
    }
    return { status: res.status, detail }
  } catch (err) {
    return { status: 0, detail: err?.name === 'AbortError' ? 'timed out' : (err?.cause?.code ?? err?.message ?? 'network error') }
  } finally {
    clearTimeout(timer)
  }
}

function isRetryable(status) {
  return status === 0 || status === 408 || status === 429 || status >= 500
}

async function sendBatch(items, key, url, now) {
  const { status, detail } = await post(
    items.map((item) => item.entry.event),
    key,
    url,
  )

  if (status >= 200 && status < 300) {
    for (const item of items) settleDelivered(item)
    try {
      fs.rmSync(AUTH_FLAG, { force: true })
    } catch {
      // not set
    }
    return
  }

  if (status === 401 || status === 403) {
    try {
      fs.writeFileSync(AUTH_FLAG, String(now))
    } catch {
      // best effort
    }
    for (const item of items) settleRetry(item, `Beacon rejected the API key (HTTP ${status})`, now, KEY_REJECTED_MIN_DELAY_MS)
    return
  }

  if (isRetryable(status)) {
    const why = status === 0 ? `could not reach Beacon (${detail})` : `HTTP ${status}`
    for (const item of items) settleRetry(item, why, now)
    return
  }

  // A 4xx that is not about the key: the request itself was refused. In a
  // batch that could be one bad event, so send each on its own and only the
  // bad ones are set aside.
  if (items.length > 1) {
    for (const item of items) await sendBatch([item], key, url, now)
    return
  }
  settleFailed(items[0], `Beacon refused the event (HTTP ${status}${detail ? `: ${detail}` : ''})`)
}

/** Send everything due, if no other sender is running. */
export async function flush() {
  if (isDisabled()) return
  const key = resolveKey()
  if (!key) return
  const url = resolveUrl()

  try {
    ensureDirs()
  } catch {
    return
  }

  // Two rounds at most: the second covers an event queued in the moment
  // between this sender's last look at the queue and its releasing the lock,
  // whose own sender saw the lock held and gave way.
  for (let round = 0; round < 2; round++) {
    const started = Date.now()
    if (!acquireLock(started)) return
    try {
      pruneFailed(started)
      while (Date.now() - started < FLUSH_BUDGET_MS) {
        const now = Date.now()
        const batch = dueEntries(now, BATCH_SIZE)
        if (batch.length === 0) break
        await sendBatch(batch, key, url, now)
        // Entries that went back in the queue are not due again yet, so the
        // next pass only picks up what is genuinely still due.
      }
    } finally {
      releaseLock()
    }
    if (!hasDueEntries()) return
  }
}

// ---------------------------------------------------------------------------
// Status, for the end-of-work warning
// ---------------------------------------------------------------------------

/**
 * What a person should hear about, if anything: updates that have been
 * failing for a while and are still waiting, updates set aside as failed
 * recently, and whether the key was rejected.
 */
export function outboxStatus(now = Date.now()) {
  let waiting = 0
  let retrying = 0
  let stuck = 0
  let lastError = null
  let lastErrorAt = 0
  for (const name of listQueued()) {
    const entry = readEntry(path.join(OUTBOX_DIR, name))
    if (!entry) continue
    waiting++
    if ((entry.attempts || 0) > 0) {
      retrying++
      // A blip that clears on the next retry is not worth a person's
      // attention; an update that has been failing for a while is.
      if (now - entry.queuedAt > STUCK_AFTER_MS) stuck++
      if ((entry.lastAttemptAt || 0) >= lastErrorAt) {
        lastErrorAt = entry.lastAttemptAt || 0
        lastError = entry.lastError
      }
    }
  }
  let failedRecently = 0
  try {
    for (const name of fs.readdirSync(FAILED_DIR)) {
      if (now - fs.statSync(path.join(FAILED_DIR, name)).mtimeMs < 24 * 60 * 60_000) failedRecently++
    }
  } catch {
    // none
  }
  return { waiting, retrying, stuck, lastError, failedRecently, keyRejected: fs.existsSync(AUTH_FLAG) }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

async function main() {
  const command = process.argv[2]
  if (command === 'flush') return flush()
  if (command === 'enqueue') {
    let input
    try {
      input = JSON.parse(readStdin())
    } catch {
      process.stderr.write('beacon-outbox: enqueue expects a JSON event on stdin; nothing queued\n')
      return
    }
    if (enqueue(input)) kickFlush({ force: true })
    return
  }
  if (command === 'status') {
    const s = outboxStatus()
    process.stdout.write(
      `waiting: ${s.waiting} (retrying: ${s.retrying}, stuck: ${s.stuck})\nfailed in the last day: ${s.failedRecently}\n` +
        `key rejected: ${s.keyRejected ? 'yes' : 'no'}\nlast error: ${s.lastError ?? 'none'}\n`,
    )
  }
}

function isRunDirectly() {
  if (!process.argv[1]) return false
  const invoked = path.resolve(process.argv[1])
  const self = fileURLToPath(import.meta.url)
  // Windows paths are case-insensitive and drive letters vary in case.
  return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self
}

// Only when run directly — hooks import this module for queueEvent/kickFlush.
if (isRunDirectly()) {
  await main().catch(() => {})
}
