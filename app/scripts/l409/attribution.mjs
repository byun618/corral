// LIFE-409 N13 — what the F13 gate writes down when it is about to fail, and LIFE-426's control
// over it.
//
// It lives in its own file because it is the one path of the native gate that cannot be exercised
// by running the gate: it is only ever called when F13 fails, and the gate is not allowed to make
// the user's configuration move in order to see it. Splitting the gathering (real `ps`, real
// mtime) from the shaping means the shaping can be fed a process list that *does* contain
// `/Users/…` and checked for leaks — which is what 01-criteria C5 asks for.
//
// usage: node app/scripts/l409/attribution.mjs selftest
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { redactor } from '../l394/redact.mjs'
import { inspect } from '../l394/leak-check.mjs'

/**
 * The shaping half: which key paths moved, which other `claude` processes were alive at that
 * moment (pid, start time, the head of argv), and when the file was last written. No configuration
 * value is read or recorded, and since LIFE-426 no local path either — the key paths arrive from
 * the collector already redacted, and every absolute path in an argv head is replaced by a salted
 * token. The head is cut to 80 characters first and redacted after, so a path the cut left
 * half-written is still a token rather than half a directory name.
 */
export function attributionFrom({ reported, psOutput, claudeConfigMtime, redact, selfPid }) {
  const changed = Object.fromEntries(Object.entries(reported.files ?? {})
    .map(([file, detail]) => [file, { added: detail.added ?? [], removed: detail.removed ?? [], changed: detail.changed ?? [] }]))
  const processes = psOutput.split('\n')
    .filter(line => /claude/i.test(line) && !line.includes('l409-claude-'))
    .map(line => line.trim())
    .map(line => {
      const match = /^(\d+)\s+(\w{3} \w{3} ?\d+ [\d:]+ \d{4})\s+(.*)$/.exec(line)
      return match === null ? { pid: null, startedAt: null, argv: redact.text(line.slice(0, 80)) }
        : { pid: Number(match[1]), startedAt: match[2], argv: redact.text(match[3].slice(0, 80)) }
    })
    .filter(entry => entry.pid !== selfPid)
  return {
    note: 'redacted key paths and process identity only; no configuration value and no local path is recorded',
    changed,
    claudeConfigMtime,
    liveClaudeProcesses: processes,
  }
}

/** The gathering half, as the gate calls it. */
export function attribution(reported, redact) {
  const claudeConfig = path.join(os.homedir(), '.claude.json')
  let psOutput = ''
  try { psOutput = execFileSync('ps', ['-Ao', 'pid=,lstart=,args='], { encoding: 'utf8' }) }
  catch { /* recorded as an empty list; the diff itself is still the evidence */ }
  let mtime = null
  try { mtime = fs.statSync(claudeConfig).mtime.toISOString() } catch { /* absent is itself an answer */ }
  return attributionFrom({ reported, psOutput, claudeConfigMtime: mtime, redact, selfPid: process.pid })
}

/**
 * The positive control 01-criteria C5 asks for: the failure path, fed a process list whose argv
 * heads are absolute paths and a diff whose key paths are the ones the collector would have
 * redacted, then leak-checked. The fake paths below must stay paths — an input without them would
 * prove nothing.
 */
function selftest() {
  const root = fs.mkdtempSync('/tmp/l409-attribution-')
  const redact = redactor(path.join(root, 'salt'))
  const psOutput = [
    '12345 Mon Sep 22 09:14:03 2026 /Users/ghost-l426/.local/bin/claude --model opus',
    '12346 Mon Sep 22 09:14:04 2026 /bin/zsh -c source /Users/ghost-l426/.zshrc && claude',
    // A line `ps` did not lay out the way the regex expects, so it takes the unparsed branch.
    'claude /Users/ghost-l426/Library/Application Support/claude/whatever-this-is',
    '999 Mon Sep 22 09:14:05 2026 /usr/bin/something-else',
  ].join('\n')
  // What `global-diff.json` looks like after the collector has redacted it.
  const reported = {
    files: {
      '.claude.json': {
        added: [`projects.${redact.token('/Users/ghost-l426/repos/private-thing')}.hasTrustDialogAccepted`],
        removed: [],
        changed: ['numStartups'],
      },
    },
  }
  const record = attributionFrom({ reported, psOutput, claudeConfigMtime: new Date().toISOString(), redact, selfPid: -1 })
  const file = path.join(root, 'f13-attribution.json')
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
  const leak = inspect([file])
  // Redacting must not have emptied the record: three `claude` lines in, three out.
  const kept = record.liveClaudeProcesses.length === 3
  const tokenised = record.liveClaudeProcesses.every(entry => /<p:[0-9a-f]{16}>/.test(entry.argv))
  const pass = leak.hits.length === 0 && kept && tokenised
  console.log(JSON.stringify({
    control: 'C5-attribution-failure-path-names-no-path',
    inputProcessLines: psOutput.split('\n').length,
    keptClaudeLines: record.liveClaudeProcesses.length,
    everyArgvTokenised: tokenised,
    leakHits: leak.hits,
    argv: record.liveClaudeProcesses.map(entry => entry.argv),
    changed: record.changed,
    pass,
  }, null, 1))
  fs.rmSync(root, { recursive: true, force: true })
  if (!pass) process.exit(1)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'selftest') selftest()
  else { console.error('usage: attribution.mjs selftest'); process.exit(2) }
}
