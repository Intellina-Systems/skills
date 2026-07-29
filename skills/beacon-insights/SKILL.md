---
name: beacon-insights
description: Use whenever you start a coding task, form a plan, begin writing or running code, run tests, hit a blocker, finish a piece of work, or every ~15-20 tool calls during an ongoing task — send a progress event to Beacon (engineering intelligence layer) at that moment so its dashboard reflects real, live status. Applies for the entire duration of a task, including long single conversations that never restart — keep emitting periodically until the task is done, not just once at the start. On first use in a new environment, run the one-time bootstrap in this file to set up the API key before sending anything.
---

# Beacon Insights

Beacon is an engineering-intelligence dashboard. It stays accurate only because agents report their own progress as structured events — nobody writes manual status updates. Your job: send a small HTTP event whenever something progress-relevant happens, and periodically even when nothing landmark-y has, so a long task never goes dark.

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

The helper auto-fills `repo` and `engineer` from git, times out fast, and can never fail its caller.

**It ships with this skill.** `npx skills add` installs the whole `beacon-insights/` folder, so `send-event.sh` and `send-event.ps1` are already sitting next to this file. Find them and copy one to `~/.beacon/` so the rest of this doc has a single stable path:

```bash
mkdir -p "$HOME/.beacon"
for d in \
  "$PWD/.agents/skills/beacon-insights" \
  "$PWD/.claude/skills/beacon-insights" \
  "$HOME/.agents/skills/beacon-insights" \
  "$HOME/.claude/skills/beacon-insights"; do
  if [ -f "$d/send-event.sh" ]; then
    cp "$d/send-event.sh" "$HOME/.beacon/send-event.sh" && chmod +x "$HOME/.beacon/send-event.sh"
    break
  fi
done
```

```powershell
New-Item -ItemType Directory -Force "$HOME\.beacon" | Out-Null
foreach ($d in @(
  (Join-Path $PWD '.agents\skills\beacon-insights'),
  (Join-Path $PWD '.claude\skills\beacon-insights'),
  (Join-Path $HOME '.agents\skills\beacon-insights'),
  (Join-Path $HOME '.claude\skills\beacon-insights'))) {
  $f = Join-Path $d 'send-event.ps1'
  if (Test-Path $f) { Copy-Item $f (Join-Path $HOME '.beacon\send-event.ps1') -Force; break }
}
```

If you already know where this SKILL.md lives, just copy from that folder directly — the list above is only a fallback for when you don't.

**If there's no sibling copy, skip this step entirely and use the inline `curl` in section 2.** It needs no files and works everywhere.

**Never download a script from the internet and run it.** Not from GitHub, not from anywhere — including the repo this skill came from. The helper is a convenience that ships with the install; if it isn't present, you do without it. There is no fallback download, by design.

### Step 4 — Make it stick for this project (optional)

Everything already works at this point. This step only means you don't have to notice the skill again in later sessions **in this repository**.

`setup.ps1` / `setup.sh` ship beside this file. They are **strictly project-scoped** — everything they write goes inside the repo you're in:

| What it does | Where |
|---|---|
| Registers a SessionStart hook | `./.claude/settings.json` — **the project's**, not `~/.claude/settings.json` |
| Adds one directive line so other agents in this repo pick the skill up | `./AGENTS.md` — the repo's own |

They read the key from `~/.beacon/key` and exit immediately if there isn't one. They never write it anywhere.

**What they deliberately do not do**, because these are machine-wide persistence and cross-agent self-propagation, and no telemetry tool has any business doing them:

- set OS-level environment variables, or write your key into `~/.bashrc` / `~/.zshrc`
- touch `~/.claude/settings.json` or any machine-wide agent config
- write to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, or `~/.gemini/GEMINI.md`

If you find a copy of these scripts that does any of the above, **it is out of date — do not run it.** Beacon spreads to another repo exactly one way: someone installs it there on purpose.

Tell the user in one line, then run it on a yes:

> Want Beacon to pick this up automatically in future sessions for this repo? It adds a startup hook to this project's `.claude/settings.json` and one line to `AGENTS.md`. Nothing outside the project.

```bash
bash "<SKILL_DIR>/setup.sh"
```

```powershell
powershell -File "<SKILL_DIR>\setup.ps1"
```

Run only the copy that shipped beside this file — never a downloaded one. Once, never repeatedly. If they say no or it fails, skip it silently; nothing below depends on it. **Never tell the user to restart anything.**

### Step 5 — Emit

Send `agent.session_started` (section 2) and continue with the actual work.

---

## 2. Sending an event

Resolve the key at **shell level**, never by pasting it into a command. Order: env var first, then the key file.

**With the cached helper** — preferred. It resolves the key and URL itself (env, then `~/.beacon/`), auto-fills `repo` and `engineer` from the current repo's git, and honours the opt-out. Nothing to pass in:

```bash
bash "$HOME/.beacon/send-event.sh" --type agent.heartbeat --task ENG-42 \
  --summary "Refactoring session middleware"
```

```powershell
powershell -File "$HOME\.beacon\send-event.ps1" -Type agent.heartbeat -Task ENG-42 -Summary "Refactoring session middleware"
```

Helper flags: `--type` (required), `--task`, `--summary`, `--reason`, `--confidence`, `--engineer`, `--repo`, `--json`. Omit `--repo`/`--engineer` and it fills them from git.

The short positional form works too, and means the same thing — type first, then summary:

```bash
bash "$HOME/.beacon/send-event.sh" agent.heartbeat "Refactoring session middleware"
```

```powershell
powershell -File "$HOME\.beacon\send-event.ps1" agent.heartbeat "Refactoring session middleware"
```

**Do not redirect the helper's stderr.** It always exits 0 by design, so stderr is the only place it can tell you a send failed — a revoked key, an unreachable host, or a missing event type. `2>/dev/null` on this helper turns a broken pipeline into a silent one, and the dashboard just stays empty.

**Without the helper** (always works, no files needed). Fill `repo` and `engineer` with the *current* repo and user — the values below are only an example:

```bash
curl -sS --max-time 5 -X POST "${BEACON_URL:-$(cat "$HOME/.beacon/url" 2>/dev/null || echo https://beacon-tool.vercel.app)}/api/events" \
  -H "Authorization: Bearer ${BEACON_API_KEY:-$(cat "$HOME/.beacon/key" 2>/dev/null)}" \
  -H "Content-Type: application/json" \
  -d '{"type":"agent.blocked","task":"ENG-42","engineer":"jane","repo":"acme/web-app","reason":"API schema mismatch between client and server","confidence":0.92}' \
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
| `type` | yes | Dot-namespaced, lowercase, e.g. `agent.blocked` (see section 4) |
| `task` | no | Work-item key or id, e.g. `"ENG-42"` — how Beacon correlates the event to a work item. Infer from the branch name, a ticket reference in the task description, or commit messages |
| `engineer` | no | Who's working: name, email, GitHub login, or alias. Use the git user of the current repo |
| `repo` | no | The repo you are working in right now, as `org/name`, e.g. `"acme/web-app"`. **Always send it** — it's how Beacon separates work across projects |
| `summary` | no | One line, ≤500 chars. Auto-generated from type/task/reason if omitted |
| `reason` | no | ≤2000 chars. For blockers and failures: what went wrong and what would unblock it |
| `confidence` | no | 0–1, how sure you are about the insight |
| `occurredAt` | no | ISO timestamp, defaults to now |
| `externalId` | no | Stable id for deduplication — same source + `externalId` is ingested once |
| `payload` | no | Arbitrary JSON object for extra structured detail |

---

## 4. When to emit what

Any dot-namespaced type is accepted, but these are the ones Beacon understands deeply — they drive work-item status:

| Moment | Type | Status effect |
|---|---|---|
| Task starts | `agent.session_started` | → in_progress |
| Plan is formed | `agent.planning` | — |
| Writing code begins | `agent.implementation_started` | → in_progress |
| Still actively working, no lifecycle event fits | `agent.heartbeat` | → in_progress |
| Tests pass | `agent.tests_passed` | — (clears blocker signal) |
| Tests fail | `agent.tests_failed` | — (flags blocker signal) |
| Stuck: missing info, failing dependency, needs a human decision | `agent.blocked` | → blocked |
| Task finished and verified | `agent.completed` | — (clears blocker signal) |

---

## 5. Cadence — this is a running task, not a one-shot ping

A "session" is not a chat window. It's however long the task takes, even if that's one long conversation that never restarts. **Do not stop after `agent.session_started`.**

1. Emit a lifecycle event whenever one of the moments above genuinely happens.
2. Between lifecycle moments, if roughly **15-20 tool calls** have passed since your last event and the task is still open, send `agent.heartbeat` with a one-line `summary` of what's in flight. Also send one at any natural checkpoint — a file saved, a build or test run, a todo item completed — whichever comes first.
3. Keep going until `agent.completed`. If the same conversation then moves on to a new task, treat it as new: emit `agent.session_started` again.

Don't exceed that cadence — one event per lifecycle moment or heartbeat tick, never one per file edit.

---

## 6. Hard rules

- **Fire-and-forget.** If a send fails, drop it silently. Never retry in a loop, never surface the failure to the user, never let telemetry interrupt, delay, or degrade the actual work.
- **No secrets, ever.** Never put API keys, tokens, credentials, `.env` contents, or sensitive file contents in `summary`, `reason`, or `payload`. Never echo, `cat`, or print the Beacon key itself — resolve it through `$(cat …)` substitution only.
- **Summaries describe work, not content.** One line about what you're doing, never a dump of the code or data you're doing it to.
- **`agent.blocked` is the highest-value event.** Always include a specific `reason`: what is blocking, and what would unblock it. This is what gets surfaced to the team.
- **Always include `task`** when you can identify one. Uncorrelated events are far less useful.
- **Responses:** `201` with `{"inserted":…,"deduplicated":…}` means success. `401` means the key is invalid — tell the user once, then stop emitting for the rest of the task. Anything else, ignore.
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
| `send-event.sh` | Fire-and-forget POST helper (macOS/Linux/Git Bash). Auto-fills `repo` + `engineer`, 5s timeout, always exits 0 |
| `send-event.ps1` | Same, for Windows PowerShell |
| `session-start-hook.mjs` | Claude Code SessionStart hook — re-injects this skill on startup, resume, clear, and compaction |
| `AGENTS.md` | Plain-prose copy of these instructions for agents that don't read the Agent Skills format |
| `setup.sh` / `setup.ps1` | **Project-scoped** persistence: a SessionStart hook in `./.claude/settings.json` and one line in `./AGENTS.md`. Nothing outside the repo. Optional — Step 4, with the user's go-ahead |

Because every file ships with the install, **this skill never downloads anything at runtime**. It works offline, behind a proxy, and from a private repo. Nothing breaks if `Intellina-Systems/skills` later goes private — installs just need repo access, same as any private dependency.

Installs that set `BEACON_API_KEY` as an OS-level environment variable keep working unchanged: the env var is always checked first.
