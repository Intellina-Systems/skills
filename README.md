# Intellina Systems — Agent Skills

Reusable [Agent Skills](https://www.skills.sh/) maintained by Intellina Systems.

## Skills

| Skill | What it does |
|---|---|
| [`beacon-insights`](skills/beacon-insights/) | Coding agents report their own progress to [Beacon](https://beacon-tool.vercel.app) as structured events, so the engineering dashboard reflects live status instead of going stale |

## Install

```bash
npx skills add https://github.com/Intellina-Systems/skills --skill beacon-insights
```

That installs the whole skill folder — `SKILL.md`, the send-event helpers, the
outbox, the session hooks, and the setup scripts — into `.agents/skills/beacon-insights/`,
symlinked into every coding agent the installer detects (Claude Code, Codex,
Cursor, Gemini CLI, GitHub Copilot, OpenCode, and others).

Install for every repo on the machine instead of just the current one:

```bash
npx skills add https://github.com/Intellina-Systems/skills --skill beacon-insights -g
```

## Updating to V3

Beacon Insights is at **V3**. Re-run the install command above in each repo to
update, then (on Claude Code) run the bundled setup again. Every setup run is a
fresh install: Beacon's hooks and project note are rewritten to the current
version, and any outdated Beacon note an old version left in `~/.claude/CLAUDE.md`
(or Codex/Gemini's equivalents) is removed. Nothing to check by hand:

```bash
bash .agents/skills/beacon-insights/setup.sh
```

New in V3:

- **Nothing is lost when the network fails.** Every update is saved to a local
  outbox (`~/.beacon/outbox/`) and delivered by a background process, which
  retries failed sends with growing delays for up to 7 days.
- **Nothing waits on the network.** The helper and hooks return immediately.
- **Updates actually send.** The session reminder now gives the helper's real
  install path; V2 named a path that project installs never create, so
  planning/completed updates were often silently lost.
- **You hear about stuck updates once, at the end of a turn** — never mid-work.
  Refused updates are kept in `~/.beacon/outbox/failed/` and logged in full in
  `~/.beacon/errors.log`.

## After installing

Nothing. The agent handles the rest on first use — it asks for your Beacon API
key once, saves it to `~/.beacon/key`, and starts reporting. No script to run,
no terminal to restart.

You'll need a key from **Beacon → Settings → API Keys** (starts with `bcn_`).
If you'd rather not paste it into a chat, create it yourself first:

```bash
mkdir -p ~/.beacon && printf %s 'bcn_YOUR_KEY' > ~/.beacon/key && chmod 600 ~/.beacon/key
```

Self-hosting Beacon? Put your instance URL in `~/.beacon/url`.

Don't want it? Tell the agent no once, or run
`mkdir -p ~/.beacon && touch ~/.beacon/disabled` — it will never ask again.

## Notes

- This repo must stay **public**. The skill degrades gracefully if it isn't, but
  installs and fallback downloads will fail.
- Events never carry secrets, credentials, or file contents — only a type, a
  one-line summary, and the repo and work item it belongs to.

## Tests

```bash
node tests/beacon-insights.test.mjs
```

Runs the skill end to end against a local mock Beacon, in throwaway home
folders, so it never touches your real `~/.beacon` or the real dashboard:
delivery, retries after outages and timeouts, a rejected key, a bad event in a
batch, two senders at once (no duplicates), the Claude Code hooks, and both
helpers with and without Node.

Verified on Windows so far. macOS and Linux still need one run each — see
[`tests/README.md`](tests/README.md), which also tells a teammate's coding
agent what to do if something fails there.
