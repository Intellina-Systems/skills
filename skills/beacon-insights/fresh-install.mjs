#!/usr/bin/env node
// Makes every install a fresh one: whatever an older version of this skill
// left behind is replaced, not kept.
//
// Two jobs:
//
// 1. removeLegacyBlocks() — very old versions of setup wrote a Beacon note into
//    machine-wide agent instruction files (~/.claude/CLAUDE.md,
//    ~/.codex/AGENTS.md, ~/.gemini/GEMINI.md). That note named a helper path a
//    project install never creates and told agents to hide errors, so it kept
//    contradicting the current reminder and updates were silently lost. Only
//    the block between our own markers is removed; nothing else in those files
//    is touched. Runs from setup and from every session start, so a machine
//    heals without anyone having to know the note was there.
//
// 2. writeProjectDirective() — the one line this skill keeps in the project's
//    own AGENTS.md is rewritten to the current text every time, instead of
//    being skipped because an older line already exists.
//
// Usage (setup.sh / setup.ps1): node fresh-install.mjs <projectRoot>

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LEGACY_FILES = [
  path.join('.claude', 'CLAUDE.md'),
  path.join('.codex', 'AGENTS.md'),
  path.join('.gemini', 'GEMINI.md'),
]

// <!-- beacon-insights:auto ... --> … <!-- /beacon-insights:auto -->, plus the
// blank line it was appended after.
const LEGACY_BLOCK = /\n?<!-- beacon-insights:auto\b[^>]*-->[\s\S]*?<!-- \/beacon-insights:auto -->\n?/g

/** Remove old machine-wide Beacon notes. Returns the files it changed. */
export function removeLegacyBlocks(home = os.homedir()) {
  const changed = []
  for (const rel of LEGACY_FILES) {
    const file = path.join(home, rel)
    try {
      const before = fs.readFileSync(file, 'utf8')
      if (!before.includes('beacon-insights:auto')) continue
      const after = before.replace(LEGACY_BLOCK, '\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n')
      if (after === before) continue
      if (after.trim() === '') fs.rmSync(file, { force: true })
      else fs.writeFileSync(file, after)
      changed.push(file)
    } catch {
      // No such file, or unreadable — nothing of ours to clean there.
    }
  }
  return changed
}

export const PROJECT_DIRECTIVE =
  'This repo uses the beacon-insights skill: report coding progress to Beacon with the send-event helper in ' +
  '.agents/skills/beacon-insights (or .claude/skills/beacon-insights) — run it from there, and never hide its output. ' +
  "Use the Beacon MCP connection for the plan only. See that folder's SKILL.md for when to send what."

const PROJECT_BLOCK = /\n?<!-- beacon-insights:project\b[^>]*-->[\s\S]*?<!-- \/beacon-insights:project -->\n?/g

/** Write the current directive into the project's AGENTS.md, replacing any older one. */
export function writeProjectDirective(root) {
  const file = path.join(root, 'AGENTS.md')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    // no AGENTS.md yet
  }
  const block =
    '<!-- beacon-insights:project (managed by skills/beacon-insights/setup) -->\n' +
    `${PROJECT_DIRECTIVE}\n` +
    '<!-- /beacon-insights:project -->\n'
  const hadOne = PROJECT_BLOCK.test(text)
  PROJECT_BLOCK.lastIndex = 0
  const base = text.replace(PROJECT_BLOCK, '\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
  fs.writeFileSync(file, `${base ? `${base}\n\n` : ''}${block}`)
  return hadOne ? 'updated' : 'added'
}

function isRunDirectly() {
  if (!process.argv[1]) return false
  const invoked = path.resolve(process.argv[1])
  const self = fileURLToPath(import.meta.url)
  return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self
}

if (isRunDirectly()) {
  const root = process.argv[2]
  if (!root) {
    console.error('fresh-install: usage: node fresh-install.mjs <projectRoot>')
  } else {
    try {
      for (const file of removeLegacyBlocks()) console.log(`Removed an outdated Beacon note from ${file}`)
      console.log(`${writeProjectDirective(root) === 'updated' ? 'Updated' : 'Added'} the project directive in AGENTS.md`)
    } catch (err) {
      console.error(`fresh-install: ${err?.message ?? 'failed'}`)
    }
  }
}
