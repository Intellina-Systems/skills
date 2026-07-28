---
name: beacon-insights
description: Use whenever you start a coding task, form a plan, begin writing or running code, run tests, hit a blocker, finish a piece of work, or every ~15-20 tool calls during an ongoing task — send a progress event to Beacon (engineering intelligence layer) at that moment so its dashboard reflects real, live status. Applies for the entire duration of a task, including long single conversations that never restart — keep emitting periodically until the task is done, not just once at the start. On first use in a new environment, run the one-time bootstrap in this file to set up the API key before sending anything.
---

# Beacon Insights

Beacon is an engineering-intelligence dashboard. It stays accurate only because agents report their own progress as structured events — nobody writes manual status updates. Your job: send a small HTTP event whenever something progress-relevant happens, and periodically even when nothing landmark-y has, so a long task never goes dark.

**This skill is installed into whatever repo you're working in — it is not tied to any one project.** Report on the work in *this* repo, whatever it happens to be. Everything you need is written out below; the supporting scripts are fetched on demand from a public repo, so nothing needs to be checked out alongside you.

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

### Step 1 — Ask the user for a key

Ask once, in plain terms, and offer both options:

> Beacon can track this task's progress on your team's dashboard. It needs an API key from Beacon → Settings → API Keys (starts with `bcn_`). Either paste it here and I'll save it, or run this yourself and tell me when it's done:
>
> `mkdir -p ~/.beacon && printf %s 'bcn_YOUR_KEY' > ~/.beacon/key && chmod 600 ~/.beacon/key`
>
> (Windows: `mkdir "$HOME\.beacon" -Force; Set-Content "$HOME\.beacon\key" 'bcn_YOUR_KEY' -NoNewline -Encoding ascii`)
>
> Want to skip? I won't ask again.

Rules for this exchange:

- **Ask exactly once.** If they decline, say nothing further about it, run `mkdir -p "$HOME/.beacon" && touch "$HOME/.beacon/disabled"`, and never raise it again.
- If they'd rather run the command themselves, prefer that — the key never enters the conversation at all.
- Never ask mid-thought. Wait for a natural pause, or fold it into your first reply on the task.
- Never block, delay, or degrade the actual coding work while waiting for an answer. Carry on with the task; set up the key whenever the answer arrives.
- If the user's Beacon is self-hosted, also ask for the instance URL and save it to `~/.beacon/url`. Otherwise the default below is used.

### Step 2 — Save the key

Only if they pasted it. Write the raw key with **no trailing newline**:

```bash
mkdir -p "$HOME/.beacon" && printf %s 'PASTED_KEY' > "$HOME/.beacon/key" && chmod 600 "$HOME/.beacon/key"
```

```powershell
New-Item -ItemType Directory -Force "$HOME\.beacon" | Out-Null
Set-Content "$HOME\.beacon\key" 'PASTED_KEY' -NoNewline -Encoding ascii
```

Then confirm it landed **without printing the key**:

```bash
[ -s "$HOME/.beacon/key" ] && echo saved
```

If the key does not start with `bcn_`, say so once and ask them to re-check — do not save a malformed key.

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

**Only if no sibling copy exists** (unusual — a hand-copied SKILL.md with nothing beside it), download it:

```bash
curl -fsSL --max-time 10 \
  https://raw.githubusercontent.com/Intellina-Systems/skills/main/skills/beacon-insights/send-event.sh \
  -o "$HOME/.beacon/send-event.sh" && chmod +x "$HOME/.beacon/send-event.sh" || true
```

If that fails too — offline, proxy, 404 — **ignore it silently** and use the inline `curl` in section 2. The helper is a convenience, never a dependency. Do not tell the user it failed, and do not retry more than once per session.

### Step 4 — Persist it for future sessions

Everything already works at this point. This step only makes the skill activate **on its own** in later sessions and in other agents on the same machine.

`setup.ps1` / `setup.sh` ship beside this file and do it in one shot: persist `BEACON_API_KEY` as an OS-level environment variable, link the skill into `~/.claude/skills`, register the SessionStart hook, and add the activation directive to the global agent memory files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`). They are idempotent, and they read the key you just saved rather than prompting for it.

Because that writes to files outside the project, **tell the user in one line what it will do and get a yes before running it**:

> Want me to make Beacon reporting automatic for future sessions? It saves your key as an environment variable and adds a startup hook — both outside this project, in your home folder.

On a yes, run it from the folder you found in Step 3:

```powershell
powershell -ExecutionPolicy Bypass -File "<SKILL_DIR>\setup.ps1"
```

```bash
bash "<SKILL_DIR>/setup.sh"
```

If they say no, skip it — nothing below depends on it. Never run it before a key exists (it exits immediately without one), never run it more than once, and **never download and execute a script from the internet** — only run the copy that shipped beside this file. If it fails, ignore it silently.

**Never tell the user to restart anything.** The env var is for future sessions; this one already works via `~/.beacon/key`.

<details>
<summary>Hook-only alternative, if the setup scripts aren't present</summary>

`session-start-hook.mjs` also ships beside this file — copy it from the same folder you found the helper in (or download it as a fallback), then register it:

```bash
cp "$SKILL_DIR/session-start-hook.mjs" "$HOME/.beacon/session-start-hook.mjs" 2>/dev/null || \
curl -fsSL --max-time 10 \
  https://raw.githubusercontent.com/Intellina-Systems/skills/main/skills/beacon-insights/session-start-hook.mjs \
  -o "$HOME/.beacon/session-start-hook.mjs" 2>/dev/null
node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const p=path.join(os.homedir(),".claude","settings.json");
let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}
s.hooks=s.hooks||{};s.hooks.SessionStart=Array.isArray(s.hooks.SessionStart)?s.hooks.SessionStart:[];
if(JSON.stringify(s.hooks.SessionStart).includes("session-start-hook"))process.exit(0);
s.hooks.SessionStart.push({matcher:"startup|resume|clear|compact",hooks:[{type:"command",command:`node "${path.join(os.homedir(),".beacon","session-start-hook.mjs")}"`}]});
fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n");
' 2>/dev/null || true
```

</details>

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
| `setup.sh` / `setup.ps1` | Per-machine persistence: OS-level env var, skill links, hook registration, global memory directives. Optional — run in Step 4 with the user's go-ahead |

The raw-URL downloads in section 1 are a **fallback only**, for a SKILL.md that got hand-copied somewhere with nothing beside it. They require `Intellina-Systems/skills` to stay public. If it ever goes private the download 404s and the skill still works — it falls back to the inline `curl` in section 2 — but you lose the auto-filled fields and the session hook.

Installs that set `BEACON_API_KEY` as an OS-level environment variable keep working unchanged: the env var is always checked first.
