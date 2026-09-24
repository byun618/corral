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
 * How one process's argv is recorded. **Nothing of the argv text is kept** (review V2, then V14).
 *
 * `ps -o args=` is a single string whose argument boundaries are already lost, so replacing the
 * paths inside it and keeping the rest cannot be made safe: `--add-dir /Users/x/repo My Notes`
 * leaves `My Notes` standing, a directory name with no path shape on it, which the leak check
 * cannot see and a reader cannot tell from a flag. V2's fix stopped keeping the text but still
 * derived a `command` name from it — cut at 80 characters, split on whitespace, basename of the
 * first piece — and that put the text back in two ways V14 measured: an install path containing a
 * space (`/Users/x/TOPSECRET dir/bin/claude`) makes the "first piece" end inside a directory name,
 * and a directory long enough to push the 80-character cut into its middle leaves a fragment of it
 * (`TOPS`). Neither has a path's shape, so no checker sees either.
 *
 * There is no rule that cuts a program name out of that string safely, so this one does not try.
 * What is left is a salted digest of the first 80 characters: it still tells two processes apart,
 * still matches the same process across runs, and carries nothing back. A process is identified by
 * its `pid` and `startedAt`, which are not places. Should an identifying *name* ever be wanted, it
 * has to arrive as its own column (`ps -o comm=`) and not be carved out of `args`.
 */
const ARGV_CUT = 80
const argvOf = (head, redact) => ({ digest: redact.digest(String(head).slice(0, ARGV_CUT)) })

/**
 * The shaping half: which key paths moved, which other `claude` processes were alive at that
 * moment (pid, start time, how the argv is recorded above), and when the file was last written. No
 * configuration value is read or recorded, and since LIFE-426 no local path either — the key paths
 * arrive from the collector already redacted.
 */
export function attributionFrom({ reported, psOutput, claudeConfigMtime, redact, selfPid }) {
  const changed = Object.fromEntries(Object.entries(reported.files ?? {})
    .map(([file, detail]) => [file, { added: detail.added ?? [], removed: detail.removed ?? [], changed: detail.changed ?? [] }]))
  const processes = psOutput.split('\n')
    .filter(line => /claude/i.test(line) && !line.includes('l409-claude-'))
    .map(line => line.trim())
    .map(line => {
      const match = /^(\d+)\s+(\w{3} \w{3} ?\d+ [\d:]+ \d{4})\s+(.*)$/.exec(line)
      return match === null ? { pid: null, startedAt: null, argv: argvOf(line, redact) }
        : { pid: Number(match[1]), startedAt: match[2], argv: argvOf(match[3], redact) }
    })
    .filter(entry => entry.pid !== selfPid)
  return {
    note: 'redacted key paths and process identity only; an argv is recorded as a salted digest of its first 80 characters and nothing else — no name and no fragment is carved out of the argv text (LIFE-426 V2, V14)',
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
  const MARK = 'TOPSECRET'
  const psOutput = [
    '12345 Mon Sep 22 09:14:03 2026 /Users/ghost-l426/.local/bin/claude --model opus',
    '12346 Mon Sep 22 09:14:04 2026 /bin/zsh -c source /Users/ghost-l426/.zshrc && claude',
    // A line `ps` did not lay out the way the regex expects, so it takes the unparsed branch.
    'claude /Users/ghost-l426/Library/Application Support/claude/whatever-this-is',
    // V2's case: the directory name ends after a space, so the tail carries no path shape at all.
    `12347 Mon Sep 22 09:14:05 2026 claude --add-dir /Users/ghost-l426/repo ${MARK}`,
    // V14 ①: the space is *inside* the install path, so any rule that takes "the first piece up to
    // whitespace" ends inside a directory name and hands back `${MARK}` as the program name.
    `12348 Mon Sep 22 09:14:07 2026 /Users/ghost-l426/${MARK} dir/bin/claude --resume`,
    // V14 ②: a directory long enough that an 80-character cut lands in the middle of the *next*
    //   name, so a truncating rule keeps a fragment of it — `/Users/ghost-l426/` is 18 characters
    //   and 57 + 1 more puts the 80th inside `TOPSECRET`, leaving `TOPS`. A fragment is not a word
    //   and not a path, so nothing but this assertion would notice it.
    `12349 Mon Sep 22 09:14:08 2026 /Users/ghost-l426/${'d'.repeat(57)}/${MARK}/bin/claude`,
    '999 Mon Sep 22 09:14:06 2026 /usr/bin/something-else',
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
  const written = fs.readFileSync(file, 'utf8')
  // Redacting must not have emptied the record: six `claude` lines in, six out.
  const kept = record.liveClaudeProcesses.length === 6
  // The shape the record is allowed to have, and the *only* shape (V14): a 16-hex digest, with no
  // second field that could carry a piece of the argv text back.
  const shaped = record.liveClaudeProcesses.every(entry =>
    JSON.stringify(Object.keys(entry.argv)) === '["digest"]' && /^[0-9a-f]{16}$/.test(entry.argv.digest))
  // The assertion the leak check cannot make. A half-redacted directory name has no path shape
  // left, so only the marker's absence says the name is gone (V2) — and V14 adds the *prefix* of
  // the marker, because an 80-character cut through a directory name keeps a fragment, not a word.
  const markerSurvives = written.includes(MARK) || written.includes(MARK.slice(0, 4)) || written.includes('ghost-l426')
  const pass = leak.hits.length === 0 && kept && shaped && !markerSurvives
  console.log(JSON.stringify({
    control: 'C5-attribution-failure-path-names-no-path',
    inputProcessLines: psOutput.split('\n').length,
    keptClaudeLines: record.liveClaudeProcesses.length,
    everyArgvIsDigestOnly: shaped,
    fixtureMarkerSurvives: markerSurvives,
    fixtureMarkerPrefixSurvives: written.includes(MARK.slice(0, 4)),
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
