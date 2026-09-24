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
// A hit is reported as file, line and which pattern matched — never as the matching text. The
// output of this check is itself committed as evidence, and a report that quoted the leak would be
// the leak.
//
// usage: node app/scripts/l394/leak-check.mjs <dir-or-file> [more…]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPathish } from './redact.mjs'

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

export function inspect(targets) {
  const hits = []
  let filesScanned = 0, skipped = []
  for (const target of [targets].flat()) {
    for (const file of walkFiles(target)) {
      const buffer = fs.readFileSync(file)
      if (buffer.includes(0)) { skipped.push(file); continue }
      filesScanned++
      const text = buffer.toString('utf8')
      text.split('\n').forEach((line, index) => {
        for (const pattern of LEAK_PATTERNS)
          if (pattern.test(line)) hits.push({ file, line: index + 1, prong: 'grep', pattern: String(pattern) })
      })
      if (!file.endsWith('.json')) continue
      let parsed
      try { parsed = JSON.parse(text) } catch { continue }
      for (const { kind, text: value } of strings(parsed)) {
        const segments = pathFormSegments(value)
        if (segments.length > 0) hits.push({ file, prong: 'json-path-form', kind, segments: segments.length })
      }
    }
  }
  return { filesScanned, skipped, hits }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2)
  if (targets.length === 0) { console.error('usage: leak-check.mjs <dir-or-file> [more…]'); process.exit(2) }
  const result = inspect(targets)
  const byFile = {}
  for (const hit of result.hits) byFile[hit.file] = (byFile[hit.file] ?? 0) + 1
  console.log(JSON.stringify({
    targets,
    patterns: LEAK_PATTERNS.map(String),
    filesScanned: result.filesScanned,
    binarySkipped: result.skipped.length,
    hits: result.hits.length,
    hitsByFile: byFile,
    firstHits: result.hits.slice(0, 20),
  }, null, 1))
  if (result.hits.length > 0) process.exit(1)
}
