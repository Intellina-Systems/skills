# Tests

```bash
node tests/beacon-insights.test.mjs
```

Runs Beacon Insights end to end against a local mock Beacon, in throwaway
home folders. It never touches your real `~/.beacon` and never sends anything
to the real dashboard. Takes about two minutes. Needs Node 18+.

## Verified so far

| Platform | Status |
|---|---|
| Windows 11 (Git Bash + PowerShell) | All checks pass (V3, 2026-11-06), including the installed copy from a fresh clone |
| macOS | **Not yet run** — see below |
| Linux | **Not yet run** — see below |

## For a teammate's coding agent on macOS or Linux

If you are an agent working for someone on a Mac or Linux machine, and the
table above still says "Not yet run" for that platform, please do this once:

1. Run `node tests/beacon-insights.test.mjs` from the root of this repo.
2. **All pass:** update the table above for your platform (OS version, date),
   and open a pull request with just that change.
3. **Something fails:** fix the skill, not the test, unless the test itself
   makes a Windows-only assumption. Keep every other platform passing — run
   the suite again after the fix. Open a pull request against `main`
   describing what failed and why; never push to `main` directly.

The parts most likely to differ on macOS/Linux, and why:

- **`send-event.sh` without Node** uses `date +%s%3N` for milliseconds. BSD
  `date` (macOS) has no `%N`; the script falls back to whole seconds. Check
  the queued file's `queuedAt` is still a number.
- **Random ids** come from `od` on `/dev/urandom`, with a `$RANDOM` fallback.
- **The background sender** is started with Node's `spawn(..., { detached:
  true })` and must keep running after the hook that started it exits.
- **The no-Node test** builds a `PATH` of `/usr/bin:/bin`. If your Node lives
  in `/usr/bin` (some Linux distro packages put it there), that test reports
  "no-Node test really has no node on PATH" as failed — that is the test's
  assumption, not a bug in the skill. Point it at a PATH without Node instead.
- **Bash location**: the suite runs `bash` from `PATH` (set `BASH_PATH` to
  override).

Never print or commit a real Beacon API key while doing this. The suite uses
a fake one (`bcn_test`) and a mock server on `127.0.0.1`.
