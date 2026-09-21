// LIFE-394 — global provider-config collector (design §8.1, F16).
//
// Moved into app/scripts/l394/ for the implementation round; the design-round copy under
// raw/worker/claude/design/fix1/ is left untouched as the record of what that round actually ran.
//
// The first collector compared key NAMES only, so a changed value under an unchanged key was
// invisible (review D7 reproduced this with a synthetic config). This one compares a salted
// digest of every normalized VALUE and of the whole file. Values and credentials are never
// written out: only key paths, change flags, and trust-key names.
//
// The salt lives outside the repo (L394_SALT_FILE, default /tmp/l394-claude-salt) so the
// committed before/after digests cannot be inverted even for low-entropy values.
//
// `selftest` is a positive control for D7 and exits non-zero when it fails (C4/D25).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

const mode = process.argv[2]
const out = process.env.L394_RAW ?? '.'
const saltFile = process.env.L394_SALT_FILE ?? '/tmp/l394-claude-salt'
if (!fs.existsSync(saltFile)) fs.writeFileSync(saltFile, randomBytes(32).toString('hex'), { mode: 0o600 })
const salt = fs.readFileSync(saltFile, 'utf8').trim()
const digest = value => createHash('sha256').update(salt).update('\0').update(value).digest('hex').slice(0, 16)

const home = os.homedir()
const short = file => file.startsWith(home) ? '~' + file.slice(home.length) : file

// Files whose VALUES we compare. Hook definitions, permissions and model settings all live here.
const FILES = [
  ['json', path.join(home, '.claude.json')],
  ['json', path.join(home, '.claude/settings.json')],
  ['json', path.join(home, '.claude/settings.local.json')],
  ['toml', path.join(home, '.codex/config.toml')],
  ['json', path.join(home, '.codex/hooks.json')],
  ['toml', path.join(home, '.grok/trusted_folders.toml')],
  ['json', path.join(home, '.grok/settings.json')],
  ['toml', path.join(home, '.grok/config.toml')],
]
// Directories whose ENTRY NAMES we compare (hook scripts appearing or disappearing).
const DIRS = [path.join(home, '.claude/hooks'), path.join(home, '.codex/hooks'), path.join(home, '.grok/hooks')]

const flattenJson = (value, prefix, sink) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value).sort()) flattenJson(value[key], prefix ? `${prefix}.${key}` : key, sink)
    return
  }
  sink[prefix] = digest(JSON.stringify(value ?? null))
}

// Minimal TOML key-path reader: enough to notice a changed value under an unchanged key.
// Lines it cannot parse are digested positionally so nothing is silently dropped.
const flattenToml = (text, sink) => {
  let section = ''
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const header = trimmed.match(/^\[\[?([^\]]+)\]\]?$/)
    if (header) { section = header[1]; sink[`${section}.<section>`] = digest(trimmed); return }
    const pair = trimmed.match(/^("?[^"=]+"?)\s*=\s*(.*)$/)
    if (pair) { sink[section ? `${section}.${pair[1].replace(/"/g, '')}` : pair[1].replace(/"/g, '')] = digest(pair[2]); return }
    sink[`#line${index + 1}`] = digest(trimmed)
  })
}

const snapshot = () => {
  const files = {}
  for (const [kind, file] of FILES) {
    const key = short(file)
    if (!fs.existsSync(file)) { files[key] = { exists: false }; continue }
    const text = fs.readFileSync(file, 'utf8')
    const keys = {}
    if (kind === 'json') { try { flattenJson(JSON.parse(text), '', keys) } catch { keys['#unparsed'] = digest(text) } }
    else flattenToml(text, keys)
    const trust = {}
    for (const key of Object.keys(keys)) if (/hasTrustDialogAccepted$|^trusted/.test(key)) trust[key] = true
    files[key] = { exists: true, whole: digest(text), keyCount: Object.keys(keys).length, keys, trustKeys: Object.keys(trust).sort() }
  }
  const dirs = {}
  for (const dir of DIRS) dirs[short(dir)] = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null
  return { at: new Date().toISOString(), files, dirs }
}

if (mode === 'before' || mode === 'after') {
  fs.writeFileSync(path.join(out, `global-${mode}.json`), JSON.stringify(snapshot(), null, 2) + '\n')
  console.log(mode, 'written')
} else if (mode === 'diff') {
  const before = JSON.parse(fs.readFileSync(path.join(out, 'global-before.json'), 'utf8'))
  const after = JSON.parse(fs.readFileSync(path.join(out, 'global-after.json'), 'utf8'))
  const report = { files: {}, dirs: {}, summary: {} }
  for (const key of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    const a = before.files[key] ?? { exists: false }, b = after.files[key] ?? { exists: false }
    if (a.exists !== b.exists) { report.files[key] = { existence: { before: a.exists, after: b.exists } }; continue }
    if (!a.exists) continue
    if (a.whole === b.whole) continue
    const added = [], removed = [], changed = []
    for (const path of new Set([...Object.keys(a.keys), ...Object.keys(b.keys)])) {
      if (!(path in a.keys)) added.push(path)
      else if (!(path in b.keys)) removed.push(path)
      else if (a.keys[path] !== b.keys[path]) changed.push(path)
    }
    report.files[key] = { wholeFileChanged: true, added: added.sort(), removed: removed.sort(), changed: changed.sort() }
  }
  for (const key of Object.keys(before.dirs)) {
    const a = before.dirs[key], b = after.dirs[key]
    if (JSON.stringify(a) !== JSON.stringify(b)) report.dirs[key] = { before: a, after: b }
  }
  report.summary = {
    changedFiles: Object.keys(report.files),
    changedKeyPaths: Object.values(report.files).flatMap(f => [...(f.added ?? []), ...(f.removed ?? []), ...(f.changed ?? [])]).length,
    changedDirs: Object.keys(report.dirs),
    note: 'key paths only; no values. Files not listed here are byte-identical.',
  }
  fs.writeFileSync(path.join(out, 'global-diff.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report.summary, null, 1))
} else if (mode === 'selftest') {
  // Positive control for D7: a value change under an unchanged key must be detected.
  const dir = fs.mkdtempSync('/tmp/l394-fix1-d7-')
  const file = path.join(dir, 'settings.json')
  const flatten = text => { const keys = {}; flattenJson(JSON.parse(text), '', keys); return keys }
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { UserPromptSubmit: [{ command: 'a.sh' }] } }))
  const a = flatten(fs.readFileSync(file, 'utf8')), wholeA = digest(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(rm:*)'] }, hooks: { UserPromptSubmit: [{ command: 'evil.sh' }] } }))
  const b = flatten(fs.readFileSync(file, 'utf8')), wholeB = digest(fs.readFileSync(file, 'utf8'))
  const changed = Object.keys(a).filter(key => a[key] !== b[key]).sort()
  fs.rmSync(dir, { recursive: true, force: true })
  const expected = ['hooks.UserPromptSubmit', 'permissions.allow']
  const pass = wholeA !== wholeB && JSON.stringify(changed) === JSON.stringify(expected)
  console.log(JSON.stringify({ wholeFileChanged: wholeA !== wholeB, changed, expected, pass }, null, 1))
  if (!pass) process.exit(1)
} else {
  console.error('usage: global-config-diff.mjs before|after|diff|selftest')
  process.exit(2)
}
