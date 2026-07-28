# Beacon Insights — agent instructions

If you are a coding agent (Codex, GitHub Copilot, Gemini CLI, OpenCode, Antigravity, or anything else working in a repo that installed this skill), follow these instructions for the entire duration of every coding task, whether that's a fresh session each time or one long conversation that never restarts.

This file exists because `SKILL.md` uses the Agent Skills format (YAML frontmatter + model-invoked discovery), which not every agent reads natively. This file carries the same instructions in plain prose so the rest pick them up too — read it at the start of a coding task, and re-apply it for as long as the task runs. `SKILL.md` is the source of truth; if the two ever disagree, follow `SKILL.md`.

## What this is

Beacon is an engineering-intelligence dashboard. It stays accurate only if agents report their own progress as structured events — nobody writes manual status updates. Your job: send a small HTTP event whenever something progress-relevant happens, and periodically even when nothing landmark-y has happened, so a long task doesn't go dark.

**This skill is installed into whatever repo you're working in — it is not tied to any one project.** Report on the work in *this* repo, whatever it happens to be.

## One-time setup (per machine, not per tool)

Check, in this order:

1. `~/.beacon/disabled` exists → the user opted out. Never emit, never ask again. Stop.
2. `BEACON_API_KEY` is set, or `~/.beacon/key` is non-empty → already configured. Go to *Sending an event*.
3. Neither → ask the user **once**:

> Beacon can track this task's progress on your team's dashboard. It needs an API key from Beacon → Settings → API Keys (starts with `bcn_`). Either paste it here and I'll save it, or run this yourself:
>
> `mkdir -p ~/.beacon && printf %s 'bcn_YOUR_KEY' > ~/.beacon/key && chmod 600 ~/.beacon/key`
>
> Want to skip? I won't ask again.

If they paste it, save it with no trailing newline and `chmod 600`. If they decline, `touch ~/.beacon/disabled` and never raise it again. Prefer that they run the command themselves — then the key never enters the conversation. Confirm the file exists without ever printing the key. Don't save a key that doesn't start with `bcn_`.

Self-hosted Beacon? Also save the instance URL to `~/.beacon/url`.

Never block, delay, or degrade the coding work while waiting for an answer — carry on with the task and set the key up whenever the reply comes. Do not rely on a project's `.env`/`.env.local`: shell commands run by an agent are typically fresh, disposable processes that never source it, so the key silently never loads.

No restart is ever required. Everything below works immediately in the current session.

### Optional: cache the helper

**It ships with this skill** — `send-event.sh` / `send-event.ps1` sit in the same folder as this file, because the installer copies the whole `beacon-insights/` directory. Copy one to `~/.beacon/` so there's a single stable path:

```bash
mkdir -p ~/.beacon
for d in "$PWD/.agents/skills/beacon-insights" "$PWD/.claude/skills/beacon-insights" \
         "$HOME/.agents/skills/beacon-insights" "$HOME/.claude/skills/beacon-insights"; do
  [ -f "$d/send-event.sh" ] && cp "$d/send-event.sh" ~/.beacon/send-event.sh && chmod +x ~/.beacon/send-event.sh && break
done
```

Only if there's no sibling copy, download it as a fallback:

```bash
curl -fsSL --max-time 10 \
  https://raw.githubusercontent.com/Intellina-Systems/skills/main/skills/beacon-insights/send-event.sh \
  -o ~/.beacon/send-event.sh && chmod +x ~/.beacon/send-event.sh || true
```

If that fails too, ignore it silently and use the inline `curl` below. The helper is a convenience, never a dependency.

## Sending an event

Easiest — the helper auto-fills the repo + git identity, times out fast, and never fails the caller:

```bash
bash ~/.beacon/send-event.sh --type agent.heartbeat --task ENG-42 --summary "Refactoring session middleware"
```

It resolves the key and URL itself (env, then `~/.beacon/`), auto-fills `repo` and `engineer` from the current repo's git, and honours the opt-out — nothing to pass in. (Windows: `powershell -File ~\.beacon\send-event.ps1 -Type agent.heartbeat -Task ENG-42 -Summary "…"`. Full body/batch: `send-event.sh --json '{ "events": [ {...} ] }'`.)

Or POST directly — always works, no files needed. Resolve the key at shell level, never paste it into a command. Fill `repo` and `engineer` with the *current* repo and user; the values below are only an example:

```bash
curl -sS --max-time 5 -X POST "${BEACON_URL:-$(cat ~/.beacon/url 2>/dev/null || echo https://beacon-tool.vercel.app)}/api/events" \
  -H "Authorization: Bearer ${BEACON_API_KEY:-$(cat ~/.beacon/key 2>/dev/null)}" \
  -H "Content-Type: application/json" \
  -d '{ "type": "agent.heartbeat", "task": "ENG-42", "engineer": "jane", "repo": "acme/web-app", "summary": "…" }' >/dev/null 2>&1 || true
```

Get `repo` and `engineer` for the repo you're actually in with `git remote get-url origin` (last two path segments, strip `.git`) and `git config user.name`.

Batch up to 100 events per request with `{ "events": [ {...}, {...} ] }`. Fire-and-forget: if it fails, drop it silently, don't retry in a loop, don't surface the failure to the user, don't let it interrupt real work.

Fields: `type` (required, dot-namespaced, see below), `task` (work-item key/id — infer from branch name, ticket reference, or commit messages), `engineer` (name/email/git login), `repo` (the repo you're working in right now, as `org/name` — the helper auto-fills it; always send it), `summary` (≤500 chars), `reason` (≤2000 chars, for blockers/failures — what's wrong and what would fix it), `confidence` (0–1), `occurredAt` (ISO timestamp), `externalId` (for dedup), `payload` (extra JSON). Never put secrets, API keys, tokens, or sensitive file contents in any of these — and never echo or print the Beacon key itself.

## Event types and when to send them

| Moment | Type |
|---|---|
| Task starts | `agent.session_started` |
| Plan is formed | `agent.planning` |
| Writing code begins | `agent.implementation_started` |
| Actively working, no other event fits (see cadence) | `agent.heartbeat` |
| Tests pass | `agent.tests_passed` |
| Tests fail | `agent.tests_failed` |
| Stuck — missing info, failing dependency, needs a human decision | `agent.blocked` (include a specific `reason` — this is the highest-value event, it's what gets surfaced to the team) |
| Task finished and verified | `agent.completed` |

## Cadence — keep reporting for the whole task, not just the start

A task's "session" is however long the task actually takes, including one long conversation that never restarts. Don't stop after the first event:

1. Send a lifecycle event whenever one of the moments above genuinely happens.
2. Otherwise, roughly every 15-20 tool calls (or at a natural checkpoint — file saved, build/test run, todo item completed, whichever comes first) while the task is still open, send `agent.heartbeat` with a one-line `summary` of what's currently in flight.
3. Keep doing this until `agent.completed`. If the same conversation moves on to a new task afterward, start over with a new `agent.session_started`.

Don't send events faster than that cadence — one per lifecycle moment or heartbeat tick, not one per file edit. A `201` response means success; `401` means the key is invalid — tell the user once, then stop sending for the rest of the task.

## Where this skill lives

Canonical home: **`Intellina-Systems/skills`**, at `skills/beacon-insights/`. Install into any repo with:

```bash
npx skills add https://github.com/Intellina-Systems/skills --skill beacon-insights
```

That installs the whole folder — `SKILL.md`, both helpers, the hook, and this file — into `.agents/skills/beacon-insights/`, symlinked into each detected agent's skills directory.

`setup.sh` / `setup.ps1` are the legacy per-machine installer (OS-level env vars, skill symlinks, hook registration, global memory directives). They are **no longer required** — the setup section above replaces them — and are kept only so existing installs keep working. Installs that already set `BEACON_API_KEY` as an environment variable are unaffected: the env var is always checked first.
