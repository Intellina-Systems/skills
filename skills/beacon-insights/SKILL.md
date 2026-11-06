---
name: beacon-insights
version: 3.0.0
description: "Use whenever you form a plan or finish a piece of work — send a progress event to Beacon (engineering intelligence layer) at that moment so its dashboard reflects real, live status. Presence and activity are reported automatically by hooks once installed (see setup.sh/setup.ps1); this skill covers the two moments only a model can recognize: planning and completed. On first use in a new environment, run the one-time bootstrap in this file to set up the API key before sending anything."
---

# Beacon Insights

Beacon is an engineering-intelligence dashboard. It stays accurate only because agents report their own progress as structured events — nobody writes manual status updates. Presence and activity are reported automatically once this skill's hooks are installed (`setup.sh`/`setup.ps1`) — that part no longer depends on you. Your job is narrower: two moments only a model can recognize — a plan forming and a task actually being done — send those, each time one genuinely happens.

**This skill is installed into whatever repo you're working in — it is not tied to any one project.** Report on the work in *this* repo, whatever it happens to be.

Everything you need is written out below, and every supporting script ships beside this file. **Nothing is ever downloaded and run, and nothing outside the current project is modified** — no OS environment variables, no shell profiles, no machine-wide agent config, no global memory files. Scope is one repo, always.

---

## 1. First run — one-time bootstrap

**Do this before your first event in an environment.** It takes one pass, then never again on that machine. Work through the steps in order and stop as soon as a step says stop.

### Step 0 — Is it already set up?

```bash
[ -f "$HOME/.beacon/disabled" ] && echo DISABLED
[ -n "$BEACON_API_KEY" ] && echo ENV_OK
[ -s "$HOME/.beacon/key" ] && echo FILE_OK
```

PowerShell:

```powershell
if (Test-Path "$HOME\.beacon\disabled") { "DISABLED" }
if ($env:BEACON_API_KEY) { "ENV_OK" }
if (Test-Path "$HOME\.beacon\key") { "FILE_OK" }
```

- `DISABLED` → the user already declined. **Never emit, never ask again, for the rest of this and every future session.** Stop here.
- `ENV_OK` or `FILE_OK` → already configured. Skip to **Step 3**.
- Nothing printed → continue to Step 1.

### Step 1 — Ask the user to create a key

**Do not ask the user to paste a key into the conversation, and never handle the key value yourself.** Give them the command and let them run it, so the credential never enters the transcript. Ask once:

> Beacon can track this task's progress on your team's dashboard. If you want that, grab an API key from Beacon → Settings → API Keys (starts with `bcn_`) and run:
>
> `mkdir -p ~/.beacon && printf %s 'bcn_YOUR_KEY' > ~/.beacon/key && chmod 600 ~/.beacon/key`
>
> (Windows: `mkdir "$HOME\.beacon" -Force; Set-Content "$HOME\.beacon\key" 'bcn_YOUR_KEY' -NoNewline -Encoding ascii`)
>
> Tell me when it's done, or say skip and I won't ask again.

Rules for this exchange:

- **Ask exactly once.** If they decline, run `mkdir -p "$HOME/.beacon" && touch "$HOME/.beacon/disabled"` and never raise it again.
- If a user pastes a key anyway, don't echo it back, don't put it in a command, and tell them to rotate it — it's now in the transcript.
- Never ask mid-thought. Wait for a natural pause, or fold it into your first reply on the task.
- Never block, delay, or degrade the actual coding work over this. Carry on; pick the key up whenever it appears.
- Self-hosted Beacon? Same idea for the instance URL: `printf %s 'https://beacon.internal' > ~/.beacon/url`.

### Step 2 — Confirm it landed

Check existence only. **Never read, print, echo, or `cat` the key.**

```bash
[ -s "$HOME/.beacon/key" ] && echo saved
```

```powershell
if ((Get-Item "$HOME\.beacon\key" -ErrorAction SilentlyContinue).Length -gt 0) { "saved" }
```

If it isn't there, say so once and move on — don't loop.

### Step 3 — Locate the helper

The helper auto-fills `repo` and `engineer` from git, queues the event and returns at once, and can never fail its caller.

**It ships with this skill and runs from where it is installed** — `send-event.sh` / `send-event.ps1` sit next to this file, together with `beacon-outbox.mjs`, which they need. On Claude Code with the hooks set up, the session-start message prints the exact command with the real path on this machine; use that. Otherwise, the folder is the one this SKILL.md is in — usually `.agents/skills/beacon-insights/` or `.claude/skills/beacon-insights/` in the repo.

**Do not copy the helper somewhere else** (for example `~/.beacon/`). Away from `beacon-outbox.mjs` it can no longer queue and retry.

**If there's no helper at all, use the inline `curl` in section 2.** It needs no files, but it has no outbox — a failed send is lost.

**Never download a script from the internet and run it.** Not from GitHub, not from anywhere — including the repo this skill came from. The helper ships with the install; if it isn't present, you do without it. There is no fallback download, by design.

### Step 4 — Make it stick for this project (recommended, not just convenience)

Without this step, reporting still happens, but it depends on you remembering to run the helper for the two moments in section 4/5 below — reasonable for a short task, fragile over a long one. This step is what makes presence and activity reporting *deterministic*: it wires in hooks that fire on their own, independent of anything the model does or forgets.

`setup.ps1` / `setup.sh` ship beside this file. They are **strictly project-scoped** — everything they write goes inside the repo you're in:

| What it does | Where |
|---|---|
| Registers `SessionStart`, `PostToolUse`, `Stop`, and `SessionEnd` hooks (`session-start-hook.mjs` + `beacon-hook.mjs`) | `./.claude/settings.json` — **the project's**, not `~/.claude/settings.json` |
| Adds one directive line so other agents in this repo pick the skill up | `./AGENTS.md` — the repo's own |

They read the key from `~/.beacon/key` and exit immediately if there isn't one. They never write it anywhere.

**What they deliberately do not do**, because these are machine-wide persistence and cross-agent self-propagation, and no telemetry tool has any business doing them:

- set OS-level environment variables, or write your key into `~/.bashrc` / `~/.zshrc`
- touch `~/.claude/settings.json` or any machine-wide agent config
- write to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, or `~/.gemini/GEMINI.md`

If you find a copy of these scripts that does any of the above, **it is out of date — do not run it.** Beacon spreads to another repo exactly one way: someone installs it there on purpose.

Tell the user in one line, then run it on a yes:

> Want Beacon to report reliably in this repo, without depending on the model remembering to? It adds a handful of hooks to this project's `.claude/settings.json` and one line to `AGENTS.md`. Nothing outside the project.

```bash
bash "<SKILL_DIR>/setup.sh"
```

```powershell
powershell -File "<SKILL_DIR>\setup.ps1"
```

Run only the copy that shipped beside this file — never a downloaded one. Once, never repeatedly. If they say no or it fails, skip it silently; nothing below depends on it. **Never tell the user to restart anything.**

### Step 5 - Connect the Beacon MCP server

The plan workflow uses Beacon's MCP tools. If the `beacon` server is not already available, configure it with the native command for the current coding agent:

Claude Code:

```bash
claude mcp add --transport http beacon https://www.heybeacon.co/api/mcp
```

Codex:

```bash
codex mcp add beacon --url https://www.heybeacon.co/api/mcp
```

For Cursor, Copilot, Gemini CLI, OpenCode, or any other MCP-compatible coding agent, add this standard Streamable HTTP server using that client's MCP settings:

```json
{
  "mcpServers": {
    "beacon": {
      "type": "http",
      "url": "https://www.heybeacon.co/api/mcp"
    }
  }
}
```

Use the URL exactly as shown. It is a raw URL, not a Markdown link, and has no trailing period. The client may open a browser for sign-in and consent. Never assume the Claude command works in another agent; use the client's native MCP command or standard configuration.

If connecting MCP would modify machine-wide configuration and the user has not already asked you to connect it, show them the appropriate command instead of running it silently. A missing MCP connection must never block the coding task.

### Step 6 - Check today's plan, then emit

When the Beacon MCP server is available, call `get_plan_context` before starting work.

- If today's plan already has tasks, use the matching task and keep its id for progress events.
- If there is no plan, ask: **"What would you like to get done today?"** Turn the answer into a short, concrete checklist yourself and call `add_plan_tasks`. Do not ask the user to format or split the work.
- If the user adds more work later, call `add_plan_tasks` again. The plan is a checklist, not a one-time form.
- Link repository work to an existing work item when one clearly matches. Otherwise keep the returned plan task id and pass it as `planTaskId` on progress events.
- Offline work can stay on the plan without agent progress. Never invent progress for it.

If the MCP plan tools are unavailable or disabled, continue with the task normally. Plan reporting must never block the work.

Send `agent.session_started` where hooks do not already send it, then continue with the actual work.

---

## 2. Sending an event

Resolve the key at **shell level**, never by pasting it into a command. Order: env var first, then the key file.

**With the helper** — preferred. `<SKILL_DIR>` is the folder this file is in (the session-start message gives the exact path). It resolves the key and URL itself (env, then `~/.beacon/`), auto-fills `repo` and `engineer` from the current repo's git, and honours the opt-out. Nothing to pass in:

```bash
bash "<SKILL_DIR>/send-event.sh" --type agent.heartbeat --task ENG-42 \
  --plan-task PLAN_TASK_ID --summary "Improving sign-in reliability"
```

```powershell
powershell -File "<SKILL_DIR>\send-event.ps1" -Type agent.heartbeat -Task ENG-42 -PlanTask PLAN_TASK_ID -Summary "Improving sign-in reliability"
```

Helper flags: `--type` (required), `--task`, `--plan-task`, `--summary`, `--reason`, `--confidence`, `--engineer`, `--repo`, `--model`, `--harness`, `--json`. Omit `--repo`/`--engineer` and it fills them from git; omit `--model`/`--harness` and it detects them (see section 3). V3 helpers add `skillVersion: "3"` metadata automatically, plus a stable `externalId` and the real `occurredAt` so retries are safe.

The short positional form works too, and means the same thing — type first, then summary:

```bash
bash "<SKILL_DIR>/send-event.sh" agent.heartbeat "Improving sign-in reliability"
```

```powershell
powershell -File "<SKILL_DIR>\send-event.ps1" agent.heartbeat "Improving sign-in reliability"
```

**Do not redirect the helper's output.** It always exits 0 by design, so what it prints is the only way it can tell you something is wrong — a missing event type, or (without Node) a rejected key. `2>/dev/null` on this helper turns a broken pipeline into a silent one. Network failures are not your concern: the event is already queued and the outbox retries it.

**Without the helper** (always works, no files needed). Fill `repo` and `engineer` with the *current* repo and user — the values below are only an example:

```bash
curl -sS --max-time 5 -X POST "${BEACON_URL:-$(cat "$HOME/.beacon/url" 2>/dev/null || echo https://www.heybeacon.co)}/api/events" \
  -H "Authorization: Bearer ${BEACON_API_KEY:-$(cat "$HOME/.beacon/key" 2>/dev/null)}" \
  -H "Content-Type: application/json" \
  -d '{"type":"agent.planning","task":"ENG-42","engineer":"jane","repo":"acme/web-app","summary":"Reworking the ingest path","confidence":0.92}' \
  >/dev/null 2>&1 || true
```

Discover `repo` and `engineer` for the repo you're actually in:

```bash
git remote get-url origin   # → take the last two path segments, strip .git
git config user.name
```

Batch up to 100 events in one request with `{"events":[{...},{...}]}` (helper: `--json '<body>'`).

---

## 3. Event fields

| Field | Required | Notes |
|---|---|---|
| `type` | yes | Dot-namespaced, lowercase, e.g. `agent.planning` (see section 4) |
| `task` | no | Work-item key or id, e.g. `"ENG-42"` — how Beacon correlates the event to a work item. Infer from the branch name, a ticket reference in the task description, or commit messages |
| `engineer` | no | Who's working: name, email, GitHub login, or alias. Use the git user of the current repo |
| `repo` | no | The repo you are working in right now, as `org/name`, e.g. `"acme/web-app"`. **Always send it** — it's how Beacon separates work across projects |
| `summary` | no | One line, ≤500 chars. Auto-generated from type/task/reason if omitted |
| `reason` | no | ≤2000 chars. For failures: what went wrong and what would fix it |
| `confidence` | no | 0–1, how sure you are about the insight |
| `occurredAt` | no | ISO timestamp, defaults to now |
| `externalId` | no | Stable id for deduplication — same source + `externalId` is ingested once |
| `planTaskId` | no | Daily-plan task id returned by Beacon MCP. Include it on progress for an unlinked code task |
| `skillVersion` | no | Skill metadata. V3 helpers and hooks set `"3"` (V2 set `"2"`; a missing value means V1). Do not add it to human-facing summaries |
| `payload` | no | Arbitrary JSON object for extra structured detail |
| `model` | no | The model doing the work, as the provider's own id, e.g. `"claude-opus-5"`. **Auto-detected — don't set it by hand** |
| `harness` | no | The tool it's running inside, e.g. `"claude-code"`, `"cursor"`, `"codex"`. Auto-detected |
| `harnessVersion` | no | That tool's version, e.g. `"2.1.251"`. Auto-detected |

### The agent signature

The last three are Beacon's answer to *which model actually did this work, and where* — the dimension that separates an Opus session in Claude Code from a Sonnet session in Cursor once both are rows on the same dashboard.

**You never fill them in.** Both the helper and the hooks work them out themselves: the harness from the environment, the model from the session transcript (its `model` field only — no message content is read). Anything they can't determine is left out rather than guessed, because a placeholder like `"unknown"` becomes a category on the dashboard nobody meant to create.

Two cases where you do intervene, both rare:

- **A harness the detection doesn't recognise** — set `BEACON_HARNESS` (and `BEACON_MODEL` if you know it) in the environment, or pass `--model`/`--harness`. The detection list is best-effort and deliberately incomplete; this is the escape hatch.
- **You know the id is wrong** — an explicit flag or env var always wins over detection.

---

## 4. When to emit what

Any dot-namespaced type is accepted, but these are the ones Beacon understands deeply — they drive work-item status:

| Moment | Type | Status effect | Who sends it |
|---|---|---|---|
| Task starts | `agent.session_started` | → in_progress | **Hooks** (`session-start-hook.mjs`) — automatic |
| Every ~15-20 tool calls (files edited / commands run) | `agent.heartbeat` | → in_progress | **Hooks** (`beacon-hook.mjs`, counted, not model-driven) — automatic |
| A test command runs | `agent.tests_passed` / `agent.tests_failed` | — | **Hooks** — automatic, when detectable |
| Session ends | `agent.session_ended` | — | **Hooks** — automatic |
| Plan is formed | `agent.planning` | — | **You** — no hook can see this |
| Task finished and verified | `agent.completed` | → done | **You** — only you know it's actually done |

If the project has run `setup.sh`/`setup.ps1`, the hooks above are already wired into `.claude/settings.json` and fire on their own — presence and activity no longer depend on you remembering anything. Your job is narrower than it used to be: three semantic moments, each time one genuinely happens, nothing else.

---

## 5. Cadence — two moments, not a tool-call count

Earlier versions of this skill asked you to send a heartbeat roughly every 15-20 tool calls. Drop that — models can't reliably count their own tool calls, and the count is gone the moment context compacts. That exact cadence still happens — the hooks now count for you and send `agent.heartbeat` every ~15-20 tool calls on their own. There is nothing left for you to track by number.

1. Send `agent.planning` the moment you've formed a plan.
2. Send `agent.completed` once the task is verified done. If the same conversation then moves on to a new task, treat it as new (though `agent.session_started` itself is now the hooks' job, not yours).

That's it — two triggers, each recognizable in the moment, no counting. If something genuinely noteworthy happens that neither covers, `agent.heartbeat` with a one-line summary is fine, but it's an exception, not a cadence.

---

## How delivery works (V3)

Nothing you send waits on the network, and nothing is lost when the network fails.

1. The helper (and every hook) writes the event to **`~/.beacon/outbox/`** — one small file per event — and returns immediately.
2. A **background process** (`beacon-outbox.mjs flush`) sends what is queued, in batches. Delivered events are removed from the outbox.
3. If a send fails (offline, timed out, Beacon busy), the event **goes back in the outbox with a later retry time** — 30s, 2m, 10m, 30m, 1h, then every few hours, for up to 7 days. Every hook run and every new event gives due retries another chance.
4. If Beacon refuses an event outright (malformed), it is set aside in `~/.beacon/outbox/failed/` and written in full to `~/.beacon/errors.log`, so it can be replayed by hand. A rejected API key keeps everything queued until the key is fixed.
5. Each event carries a stable `externalId` and its real `occurredAt`, so a retry is never double-counted and still lands at the moment it happened.
6. If updates keep failing, the person sees **one short note when the agent finishes its turn** — never in the middle of the work.

Check the queue any time with `node "<SKILL_DIR>/beacon-outbox.mjs" status`.

## 6. Hard rules

- **Never in the way.** The helper queues and returns at once; delivery and retries happen in the background. Never retry a send yourself, never wait on one, never let telemetry interrupt, delay, or degrade the actual work.
- **Never hide the helper's output.** Don't add `>/dev/null`, `2>&1`, or `|| true`. It is silent when all is well; anything it prints is a real problem (a missing helper, a rejected key) worth one sentence to the user.
- **No secrets, ever.** Never put API keys, tokens, credentials, `.env` contents, or sensitive file contents in `summary`, `reason`, or `payload`. Never echo, `cat`, or print the Beacon key itself — resolve it through `$(cat …)` substitution only.
- **Summaries are for non-technical readers.** Describe the outcome you are working toward in plain language. Never mention filenames, commands, tool calls, implementation symbols, or counts of edited files. Write "Making sign-in more reliable," not "Editing auth/session.ts."
- **Always include `task`** when you can identify one. Uncorrelated events are far less useful.
- **Responses** (only if you POST with `curl` yourself): `201` with `{"inserted":…,"deduplicated":…}` means success; `401` means the key is invalid — tell the user once. The helper handles all of this itself.
- **No key, no noise.** If no key is configured and the user hasn't been asked yet, run the bootstrap. If they declined (`~/.beacon/disabled`), stay silent forever.

---

## 7. Where this skill lives

Canonical home: **`Intellina-Systems/skills`**, at `skills/beacon-insights/`.

Install into any repo:

```bash
npx skills add https://github.com/Intellina-Systems/skills --skill beacon-insights
```

**This installs the whole folder, not just this file.** All the files below land together in `.agents/skills/beacon-insights/`, symlinked into each detected agent's own skills directory. That's why section 1 looks for the helper beside this file first — in a normal install it is always already there, and no network call is needed.

| File | What it's for |
|---|---|
| `SKILL.md` | This file. The only one an agent has to read |
| `send-event.sh` | The helper for the model-sent events (macOS/Linux/Git Bash). Auto-fills `repo` + `engineer`, queues the event in the outbox and returns at once, always exits 0. Run it from this folder — it needs `beacon-outbox.mjs` beside it |
| `send-event.ps1` | Same, for Windows PowerShell |
| `beacon-outbox.mjs` | The outbox: queues every event in `~/.beacon/outbox/`, sends in the background, retries failures with backoff, sets refused events aside. `status` prints the queue |
| `beacon-client.mjs` | Shared Node helpers (key/url resolution, git lookup, throttle state, failure log) used by the hooks and the outbox — not invoked directly |
| `agent-signature.mjs` | Works out the model / harness / harness version for the hook path, from the environment and the session transcript. Never invoked directly; the shell helpers implement the same contract themselves, since they have to run without Node |
| `session-start-hook.mjs` | Claude Code SessionStart hook — queues `agent.session_started` itself, then re-injects the reminder (with the helper's real path on this machine) on startup, resume, clear, and compaction |
| `beacon-hook.mjs` | Claude Code hook covering PostToolUse, Stop, SessionEnd — the deterministic presence/activity layer, dispatched by subcommand. Counts tool calls itself and heartbeats every ~15-20; at the end of a turn, tells the person if updates are stuck |
| `merge-settings.mjs` | Idempotently registers all of the above into a project's `.claude/settings.json` — called by `setup.sh`/`setup.ps1`, not run directly |
| `AGENTS.md` | Plain-prose copy of these instructions for agents that don't read the Agent Skills format |
| `setup.sh` / `setup.ps1` | **Project-scoped** persistence: registers every hook above in `./.claude/settings.json` and adds one line to `./AGENTS.md`. Nothing outside the repo. Optional — Step 4, with the user's go-ahead |

Because every file ships with the install, **this skill never downloads anything at runtime**. It works offline, behind a proxy, and from a private repo. Nothing breaks if `Intellina-Systems/skills` later goes private — installs just need repo access, same as any private dependency.

Installs that set `BEACON_API_KEY` as an OS-level environment variable keep working unchanged: the env var is always checked first.
