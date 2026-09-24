// LIFE-426 — the leak check of 01-criteria 용어, as a script rather than as a shell pipeline.
//
// Two prongs, because one of them alone is not the criterion:
//
//   1. the grep: `/Users/`, `/private/`, `/tmp/`, `/Volumes/`, `/home/`, `~/` anywhere in the text.
//   2. the key walk: no string inside a JSON artifact, whether it is an object key or one of the
//      key paths a diff lists as a value, may contain a path-form segment — a `.`-separated segment
//      that contains `/` or starts with `~`. This catches what prong 1 cannot, `githubRepoPaths.
//      <owner>/<repo>` being the case that started it.
//
// Prong 2 reads *every* string, not only object keys, because the key paths a diff reports are
// array values. That is deliberately broader than 01-criteria's wording and never narrower (관문
// ③): a repo-relative path like `app/scripts/…` sitting in some other artifact's free text will
// be reported too, as `kind: "value"`, so the reader can tell the two apart without the check
// having to guess which strings were meant to be key paths.
//
// **Prong 2 is JSON-only** (review V10). A `.md` artifact gets prong 1 alone, so a relative
// path-form key inlined into markdown — `githubRepoPaths.owner/repo` in a sentence — would pass
// this check. The two markdown artifacts the gates write inline `summary` counts and no key paths
// (checked by reading the markdown arrays in `l409/native.mjs` and `l410/native.mjs`), so this is
// a limit of the tool, not an open hole; anything that starts inlining keys into markdown has to
// widen prong 2 first.
//
// A hit is reported as file, line and which pattern matched — never as the matching text. The
// output of this check is itself committed as evidence, and a report that quoted the leak would be
// the leak. For the same reason the paths in the report are relative to the scan root and the
// scan roots themselves are redacted (review V7): running the check with an absolute argument used
// to write the user's home path into the evidence file.
//
// What cannot be read is a hit, not a pass (review V6). A `.json` that does not parse, or one with
// a NUL in it, is counted as `prong: "unreadable"` rather than skipped in silence, and a run that
// scanned nothing at all exits non-zero — a check that inspected zero files is not a clean check.
// Binary files that are not `.json` are still skipped quietly, which is the one exemption.
//
// usage: node app/scripts/l394/leak-check.mjs <dir-or-file> [more…]
//        node app/scripts/l394/leak-check.mjs selftest
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPathish, redactor } from './redact.mjs'

/** 01-criteria 용어, verbatim. Narrowing this is the one thing the criteria forbids outright. */
export const LEAK_PATTERNS = [/\/Users\//, /\/private\//, /\/tmp\//, /\/Volumes\//, /\/home\//, /~\//]

const walkFiles = function* (target) {
  const stat = fs.statSync(target)
  if (!stat.isDirectory()) { yield target; return }
  for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name === '.git') continue
    yield* walkFiles(path.join(target, entry.name))
  }
}

/** Every string in a parsed JSON document, object keys included and marked as such. */
const strings = function* (value) {
  if (typeof value === 'string') { yield { kind: 'value', text: value }; return }
  if (Array.isArray(value)) { for (const item of value) yield* strings(item); return }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { yield { kind: 'key', text: key }; yield* strings(item) }
  }
}

export const pathFormSegments = value => value.split('.').filter(segment => isPathish(segment))

/** A file as the report names it: relative to the root it was found under, never absolute (V7). */
const scanRoot = target => (fs.statSync(target).isDirectory() ? target : path.dirname(target))
const shownAs = (root, file) => path.relative(root, file) || path.basename(file)

export function inspect(targets) {
  const hits = []
  let filesScanned = 0
  const skipped = []
  for (const target of [targets].flat()) {
    const root = scanRoot(target)
    for (const file of walkFiles(target)) {
      const shown = shownAs(root, file)
      const isJson = file.endsWith('.json')
      const buffer = fs.readFileSync(file)
      if (buffer.includes(0)) {
        skipped.push(shown)
        // A `.json` we cannot read is a failed check, not an absent one (V6).
        if (isJson) hits.push({ file: shown, prong: 'unreadable', reason: 'binary' })
        continue
      }
      filesScanned++
      const text = buffer.toString('utf8')
      text.split('\n').forEach((line, index) => {
        for (const pattern of LEAK_PATTERNS)
          if (pattern.test(line)) hits.push({ file: shown, line: index + 1, prong: 'grep', pattern: String(pattern) })
      })
      if (!isJson) continue
      let parsed
      try { parsed = JSON.parse(text) } catch { hits.push({ file: shown, prong: 'unreadable', reason: 'json' }); continue }
      for (const { kind, text: value } of strings(parsed)) {
        const segments = pathFormSegments(value)
        if (segments.length > 0) hits.push({ file: shown, prong: 'json-path-form', kind, segments: segments.length })
      }
    }
  }
  return { filesScanned, skipped, hits }
}

/**
 * The CLI's exit rule, as a function so the selftest asserts on the same one the CLI uses: a hit
 * fails, and so does a run that scanned nothing (V6 — the expected evidence not being there is
 * not a clean bill of health).
 */
export const exitCode = result => (result.hits.length > 0 || result.filesScanned === 0 ? 1 : 0)

/** What the CLI prints. `redactText` is applied to the scan roots (V7). */
export const report = (targets, result, redactText = value => String(value)) => {
  const byFile = {}
  for (const hit of result.hits) byFile[hit.file] = (byFile[hit.file] ?? 0) + 1
  return {
    targets: targets.map(redactText),
    note: 'paths are relative to their scan root; the roots themselves are redacted (V7)',
    patterns: LEAK_PATTERNS.map(String),
    filesScanned: result.filesScanned,
    binarySkipped: result.skipped.length,
    hits: result.hits.length,
    hitsByFile: byFile,
    firstHits: result.hits.slice(0, 20),
  }
}

/**
 * The controls for this file's own two review findings. V7: the report of a scan that *did* find
 * something, run with an absolute argument, must itself pass the leak patterns — the check must be
 * safe to point at anything. V6: an unreadable `.json` and a scan that read nothing must both come
 * back as failures. Each one carries its own positive control, because "no hits" is also what a
 * checker that stopped looking returns.
 */
function selftest() {
  const results = []
  const record = (id, pass, detail) => { results.push({ id, pass, ...detail }); return pass }
  const root = fs.mkdtempSync('/tmp/l394-leak-selftest-')
  const redact = redactor(path.join(root, 'salt'))

  // V7 — a planted absolute path, found, and a report that does not repeat it.
  const planted = path.join(root, 'planted')
  fs.mkdirSync(planted)
  fs.writeFileSync(path.join(planted, 'artifact.json'),
    JSON.stringify({ projects: { '/Users/ghost-l426/repos/TOPSECRET': { hasTrustDialogAccepted: true } } }, null, 1))
  const found = inspect([planted])
  const printed = JSON.stringify(report([planted], found, value => redact.text(value)), null, 1)
  const selfHits = printed.split('\n').flatMap((line, index) =>
    LEAK_PATTERNS.filter(pattern => pattern.test(line)).map(pattern => ({ line: index + 1, pattern: String(pattern) })))
  record('V7-the-report-of-a-hit-does-not-carry-the-path',
    found.hits.length > 0 && selfHits.length === 0 && !printed.includes('TOPSECRET') && exitCode(found) === 1,
    { plantedFileHits: found.hits.length, hitsInOwnOutput: selfHits, exit: exitCode(found) })

  // V6 — a `.json` that cannot be read, in both of its shapes, and a scan of nothing.
  const broken = path.join(root, 'broken')
  fs.mkdirSync(broken)
  fs.writeFileSync(path.join(broken, 'unparsed.json'), '{"projects": {"prefix.~TOPSECRET": 1}')
  fs.writeFileSync(path.join(broken, 'nul.json'), Buffer.concat([Buffer.from('{"/Users/ghost-l426/TOPSECRET": 1}'), Buffer.from([0])]))
  fs.writeFileSync(path.join(broken, 'fine.json'), JSON.stringify({ ok: 'no path here' }))
  const unreadable = inspect([broken])
  const reasons = unreadable.hits.filter(hit => hit.prong === 'unreadable').map(hit => hit.reason).sort()
  const empty = inspect([fs.mkdtempSync('/tmp/l394-leak-empty-')])
  record('V6-what-cannot-be-read-is-a-hit-and-an-empty-scan-fails',
    JSON.stringify(reasons) === JSON.stringify(['binary', 'json']) && exitCode(unreadable) === 1
    && empty.filesScanned === 0 && empty.hits.length === 0 && exitCode(empty) === 1,
    { unreadable: { reasons, filesScanned: unreadable.filesScanned, exit: exitCode(unreadable) },
      emptyScan: { filesScanned: empty.filesScanned, hits: empty.hits.length, exit: exitCode(empty) } })

  // The oracle for both: a clean tree still comes back clean, so the two failures above are the
  // reasons stated and not the checker failing everything it is handed.
  const clean = path.join(root, 'clean')
  fs.mkdirSync(clean)
  fs.writeFileSync(path.join(clean, 'artifact.json'), JSON.stringify({ projects: { 'projects.<p:0123456789abcdef>.x': 1 } }))
  const cleanResult = inspect([clean])
  record('V6-V7-control-a-clean-tree-passes',
    cleanResult.hits.length === 0 && cleanResult.filesScanned === 1 && exitCode(cleanResult) === 0,
    { filesScanned: cleanResult.filesScanned, hits: cleanResult.hits.length, exit: exitCode(cleanResult) })

  fs.rmSync(root, { recursive: true, force: true })
  const pass = results.every(entry => entry.pass)
  console.log(JSON.stringify({ controls: results, pass }, null, 1))
  if (!pass) process.exit(1)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2)
  if (targets.length === 0) { console.error('usage: leak-check.mjs <dir-or-file> [more…] | selftest'); process.exit(2) }
  if (targets[0] === 'selftest' && targets.length === 1) selftest()
  else {
    const result = inspect(targets)
    // The redactor is built here and not inside `inspect`, so importing this module never touches
    // a salt file. Default matches the collector's.
    const redact = redactor(process.env.L394_SALT_FILE ?? '/tmp/l394-claude-salt')
    console.log(JSON.stringify(report(targets, result, value => redact.text(value)), null, 1))
    if (result.filesScanned === 0) console.error('leak-check: nothing was scanned — a check that read no files is not a pass.')
    process.exit(exitCode(result))
  }
}
