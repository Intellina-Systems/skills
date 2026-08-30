# Beacon Insights — agent instructions

If you are a coding agent (Codex, GitHub Copilot, Gemini CLI, OpenCode, Antigravity, or anything else working in a repo that installed this skill), follow these instructions for the entire duration of every coding task, whether that's a fresh session each time or one long conversation that never restarts.

This file exists because `SKILL.md` uses the Agent Skills format (YAML frontmatter + model-invoked discovery), which not every agent reads natively. This file carries the same instructions in plain prose so the rest pick them up too — read it at the start of a coding task, and re-apply it for as long as the task runs. `SKILL.md` is the source of truth; if the two ever disagree, follow `SKILL.md`.

## What this is

Beacon is an engineering-intelligence dashboard. It stays accurate only if agents report their own progress as structured events — nobody writes manual status updates.

**If you're running under Claude Code and this project has run `setup.sh`/`setup.ps1`**, presence and activity (session start, a heartbeat every ~15-20 tool calls, test results, session end) are reported automatically by hooks — that part no longer depends on you. Your job is narrower: three moments only a model can recognize (see *Event types* below).

**On every other agent platform** (Codex, GitHub Copilot, Gemini CLI, OpenCode, Antigravity), there is no equivalent hook mechanism today, so presence is still best-effort and depends on you: send `agent.session_started` when a task begins, and check in with `agent.heartbeat` at natural checkpoints as the task runs, so a long task doesn't go dark.

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

If there's no sibling copy, skip this and use the inline `curl` below — it needs no files. **Never download a script from the internet and run it**, including from the repo this skill came from. There is no fallback download, by design.

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

### The agent signature — `model`, `harness`, `harnessVersion`

Three more fields record *which model did this work, and where*: `model` is the provider's own id (`"claude-opus-5"`, `"gpt-5"`), `harness` the tool it ran inside (`"claude-code"`, `"cursor"`, `"codex"`), `harnessVersion` that tool's version. Without them, every agent's work looks identical on the dashboard.

**Don't fill these in by hand.** The helper detects them — the harness from environment variables, the model from the session transcript where one exists. Whatever it can't determine it leaves out, deliberately: an absent field is honest, and a placeholder like `"unknown"` becomes a category nobody meant to create.

If you're on a platform the detection doesn't recognise (it's a best-effort list), either export `BEACON_HARNESS` and `BEACON_MODEL`, or pass `--model` / `--harness` to the helper — an explicit value always wins. If you're POSTing with `curl` instead of the helper, set them yourself the same way, and only with values you actually know.

## Event types and when to send them

| Moment | Type | On Claude Code with hooks installed |
|---|---|---|
| Task starts | `agent.session_started` | Sent automatically — you don't need to |
| Plan is formed | `agent.planning` | Still yours — no hook can see this |
| Every ~15-20 tool calls | `agent.heartbeat` | Sent automatically — hooks count, not you |
| Tests pass / fail | `agent.tests_passed` / `agent.tests_failed` | Sent automatically, when detectable |
| Stuck — missing info, failing dependency, needs a human decision | `agent.blocked`, with a specific `reason` — the highest-value event, it's what gets surfaced to the team | Still yours — hooks never send this. A permission prompt or idle wait isn't a blocker and isn't reported |
| Task finished and verified | `agent.completed` | Still yours — only you know it's actually done |

On any other platform, none of the "sent automatically" column applies — send `agent.session_started`, `agent.heartbeat`, and test results yourself, the same as the three that are always yours.

## Cadence — three moments, not a tool-call count

Don't count tool calls. A model can't reliably track its own count, and the count is gone the moment context compacts — this used to be the instruction here and it was the single most fragile part of the whole skill.

1. Send `agent.planning` the moment you've formed a plan.
2. Send `agent.blocked` the moment you're about to ask the user something you can't resolve yourself — always with a specific `reason`.
3. Send `agent.completed` once the task is verified done. If the same conversation moves on to a new task afterward, treat it as new — send `agent.session_started` again (on platforms without the hook layer; on Claude Code with hooks installed, that one's automatic).

On platforms without the hook layer, also send `agent.heartbeat` at natural checkpoints while the task is still open — a file saved, a build or test run, a todo item completed — so presence doesn't depend on a single event at the start. There's no target frequency to hit; send it when something happened, not on a schedule.

A `201` response means success; `401` means the key is invalid — tell the user once, then stop sending for the rest of the task.

## Where this skill lives

Canonical home: **`Intellina-Systems/skills`**, at `skills/beacon-insights/`. Install into any repo with:

```bash
npx skills add https://github.com/Intellina-Systems/skills --skill beacon-insights
```

That installs the whole folder — `SKILL.md`, both send-event helpers, `beacon-client.mjs`, `agent-signature.mjs`, the two Claude Code hook scripts (`session-start-hook.mjs`, `beacon-hook.mjs`), `merge-settings.mjs`, and this file — into `.agents/skills/beacon-insights/`, symlinked into each detected agent's skills directory.

`setup.sh` / `setup.ps1` are **recommended on Claude Code, and strictly project-scoped**: they register `SessionStart`, `PostToolUse`, `Stop`, and `SessionEnd` hooks in `./.claude/settings.json` (this is what makes presence/activity reporting deterministic instead of depending on the model) and add one directive line to `./AGENTS.md`, both inside the current repo. They never set OS environment variables, never edit shell profiles, and never write to `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, or `~/.gemini/GEMINI.md` — that would be machine-wide persistence and cross-agent self-propagation. If you find a copy that does any of that, it is out of date; don't run it. On platforms without a comparable hook system, this step is a no-op — presence there stays best-effort per the *Cadence* section above.

Beacon spreads to another repo exactly one way: someone installs it there on purpose.

Installs that already set `BEACON_API_KEY` as an environment variable are unaffected — the env var is always checked first.
