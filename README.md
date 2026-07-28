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
session hook, and the setup scripts — into `.agents/skills/beacon-insights/`,
symlinked into every coding agent the installer detects (Claude Code, Codex,
Cursor, Gemini CLI, GitHub Copilot, OpenCode, and others).

Install for every repo on the machine instead of just the current one:

```bash
npx skills add https://github.com/Intellina-Systems/skills --skill beacon-insights -g
```

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
