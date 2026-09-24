// LIFE-394 — global provider-config collector (design §8.1, F16).
//
// Moved into app/scripts/l394/ for the implementation round; the design-round copy under
// raw/worker/claude/design/fix1/ is left untouched as the record of what that round actually ran.
//
// The first collector compared key NAMES only, so a changed value under an unchanged key was
// invisible (review D7 reproduced this with a synthetic config). This one compares a salted
// digest of every normalized VALUE and of the whole file. Values and credentials are never
// written out.
//
// LIFE-426: neither are key paths. `~/.claude.json` keys its `projects.*` tree by absolute
// directory, `~/.codex/config.toml` keys its trust sections the same way and every key of
// `~/.grok/trusted_folders.toml` is a directory, so a committed snapshot used to carry the user's
// directory listing in plaintext. Two changes fix that:
//
//   X. `global-before.json` / `global-after.json` carry counts and digests only — `exists`,
//      `whole`, `keyCount`, `trustKeyCount`, `keysDigest`. The per-key map they used to inline
//      moves to a sidecar beside the salt, outside the repository (`L394_SIDECAR_DIR`).
//   Y. Every key path that any artifact still names — the sidecar, `global-diff.json`, and
//      whatever the gates build from them — has its path-form segments replaced by `<p:digest>`
//      under the run's salt (`redact.mjs`). The leading segment and the trailing key name survive,
//      so `projects.<p:…>.hasTrustDialogAccepted` still classifies as a trust key (LIFE-410 F14)
//      and `summary` still counts what moved (LIFE-409 F13).
//
// `diff` binds the sidecar to the snapshot it belongs to: the sidecar's key list is re-digested and
// must equal the `keysDigest` the snapshot recorded. A missing or mismatched sidecar is a hard
// failure, never an empty diff — an empty diff is what the gates read as "nothing moved".
//
// The salt lives outside the repo (L394_SALT_FILE, default /tmp/l394-claude-salt) so the committed
// digests, value and path alike, cannot be inverted even for low-entropy inputs.
//
// `selftest` is the positive control: D7's value change, key add/remove, a trust key, and an
// end-to-end run over a fake home whose keys are absolute paths, checked for leaks. It exits
// non-zero when any of the four fails (C3/C4/D25).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { redactor } from './redact.mjs'
import { inspect } from './leak-check.mjs'

const mode = process.argv[2]
const out = process.env.L394_RAW ?? '.'
const saltFile = process.env.L394_SALT_FILE ?? '/tmp/l394-claude-salt'
const redact = redactor(saltFile)
const digest = redact.digest

const home = os.homedir()

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

/**
 * The per-key map, kept beside the salt rather than in the repository. It is named for the raw
 * directory it belongs to, so a `before` and a `diff` of the same run find each other and two runs
 * side by side do not. Its keys are redacted too: no artifact of this collector, committed or not,
 * holds a plaintext directory name.
 */
const sidecarDir = process.env.L394_SIDECAR_DIR ?? path.dirname(saltFile)
const scope = digest('l394-sidecar\0' + path.resolve(out))
const sidecarFile = which => path.join(sidecarDir, `l394-keys-${scope}-${which}.json`)

// A key is redacted segment by segment, never by splitting the finished path: an absolute path
// contains dots of its own (`/Users/x/.claude`), and splitting the join back apart would cut it in
// the wrong places.
const flattenJson = (value, prefix, sink) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value).sort()) {
      const segment = redact.segment(key)
      flattenJson(value[key], prefix ? `${prefix}.${segment}` : segment, sink)
    }
    return
  }
  sink[prefix] = digest(JSON.stringify(value ?? null))
}

/** `a.b."/Users/x".c` → the parts, with quoted parts unquoted. Dots inside quotes do not split. */
const tomlSectionParts = name => {
  const parts = []
  let current = '', quoted = false
  for (const character of name) {
    if (character === '"') { quoted = !quoted; continue }
    if (character === '.' && !quoted) { parts.push(current); current = ''; continue }
    current += character
  }
  parts.push(current)
  return parts
}
const redactTomlName = name => tomlSectionParts(name).map(part => redact.segment(part)).join('.')

// Minimal TOML key-path reader: enough to notice a changed value under an unchanged key.
// Lines it cannot parse are digested positionally so nothing is silently dropped.
const flattenToml = (text, sink) => {
  let section = ''
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const header = trimmed.match(/^\[\[?([^\]]+)\]\]?$/)
    if (header) { section = redactTomlName(header[1]); sink[`${section}.<section>`] = digest(trimmed); return }
    const pair = trimmed.match(/^("?[^"=]+"?)\s*=\s*(.*)$/)
    if (pair) {
      const key = redact.segment(pair[1].replace(/"/g, '').trim())
      sink[section ? `${section}.${key}` : key] = digest(pair[2])
      return
    }
    sink[`#line${index + 1}`] = digest(trimmed)
  })
}

/** The trust keys, by the same shape LIFE-410 F14 classifies with. Redaction preserves both ends. */
const isTrustKey = key => /hasTrustDialogAccepted$|^trusted/.test(key)

const snapshot = () => {
  const files = {}, sidecar = {}
  for (const [kind, file] of FILES) {
    const key = redact.label(file)
    if (!fs.existsSync(file)) { files[key] = { exists: false }; continue }
    const text = fs.readFileSync(file, 'utf8')
    const keys = {}
    if (kind === 'json') { try { flattenJson(JSON.parse(text), '', keys) } catch { keys['#unparsed'] = digest(text) } }
    else flattenToml(text, keys)
    const names = Object.keys(keys).sort()
    const keysDigest = digest(JSON.stringify(names))
    files[key] = {
      exists: true,
      whole: digest(text),
      keyCount: names.length,
      trustKeyCount: names.filter(isTrustKey).length,
      keysDigest,
    }
    sidecar[key] = { keysDigest, keys }
  }
  const dirs = {}
  for (const dir of DIRS) dirs[redact.label(dir)] = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null
  return {
    at: new Date().toISOString(),
    note: 'counts and salted digests only; no configuration value and no key path is written here (LIFE-426)',
    files,
    dirs,
    sidecar,
  }
}

/** Read one snapshot's sidecar and prove it is the sidecar of *that* snapshot. */
const readSidecar = (which, taken) => {
  const file = sidecarFile(which)
  if (!fs.existsSync(file)) {
    console.error(`global-config-diff: the ${which} key sidecar is missing (${path.basename(file)} under L394_SIDECAR_DIR).`)
    console.error('A diff cannot be computed without it, and reporting zero changed key paths here would be read as "nothing moved".')
    process.exit(3)
  }
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const [label, detail] of Object.entries(taken.files)) {
    if (detail.exists !== true) continue
    const held = stored.files?.[label]
    const recomputed = held ? digest(JSON.stringify(Object.keys(held.keys).sort())) : null
    if (recomputed !== detail.keysDigest) {
      console.error(`global-config-diff: the ${which} key sidecar does not belong to global-${which}.json (${label}).`)
      console.error('Re-run before/after; a diff computed from a foreign sidecar would be a claim about another run.')
      process.exit(3)
    }
  }
  return stored
}

if (mode === 'before' || mode === 'after') {
  const { sidecar, ...taken } = snapshot()
  fs.writeFileSync(path.join(out, `global-${mode}.json`), JSON.stringify(taken, null, 2) + '\n')
  fs.mkdirSync(sidecarDir, { recursive: true })
  fs.writeFileSync(sidecarFile(mode), JSON.stringify({ at: taken.at, raw: scope, files: sidecar }, null, 2) + '\n', { mode: 0o600 })
  console.log(mode, 'written')
} else if (mode === 'diff') {
  const before = JSON.parse(fs.readFileSync(path.join(out, 'global-before.json'), 'utf8'))
  const after = JSON.parse(fs.readFileSync(path.join(out, 'global-after.json'), 'utf8'))
  const beforeKeys = readSidecar('before', before), afterKeys = readSidecar('after', after)
  const report = { files: {}, dirs: {}, summary: {} }
  for (const key of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    const a = before.files[key] ?? { exists: false }, b = after.files[key] ?? { exists: false }
    if (a.exists !== b.exists) { report.files[key] = { existence: { before: a.exists, after: b.exists } }; continue }
    if (!a.exists) continue
    if (a.whole === b.whole) continue
    const aKeys = beforeKeys.files[key].keys, bKeys = afterKeys.files[key].keys
    const added = [], removed = [], changed = []
    for (const keyPath of new Set([...Object.keys(aKeys), ...Object.keys(bKeys)])) {
      if (!(keyPath in aKeys)) added.push(keyPath)
      else if (!(keyPath in bKeys)) removed.push(keyPath)
      else if (aKeys[keyPath] !== bKeys[keyPath]) changed.push(keyPath)
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
    note: 'redacted key paths only; no values. Files not listed here are byte-identical.',
  }
  fs.writeFileSync(path.join(out, 'global-diff.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report.summary, null, 1))
} else if (mode === 'selftest') {
  selftest()
} else {
  console.error('usage: global-config-diff.mjs before|after|diff|selftest')
  process.exit(2)
}

/**
 * Four positive controls (01-criteria C3). ① a value change under an unchanged key — D7, the
 * finding this collector exists for; ② a key added and a key removed; ③ a trust key added, and
 * still classified as trust after redaction (C4); ④ a fake home whose JSON and TOML keys are
 * absolute paths, run end to end, with every artifact leak-checked.
 *
 * ②③④ drive the real script in a child process over a fake `HOME`, so what is under test is the
 * pipeline that the gates run, not a re-implementation of it.
 */
function selftest() {
  const results = []
  const record = (id, pass, detail) => { results.push({ id, pass, ...detail }); return pass }

  // ① D7, in process and unchanged: a value change under an unchanged key must be visible.
  const d7dir = fs.mkdtempSync('/tmp/l394-fix1-d7-')
  const d7file = path.join(d7dir, 'settings.json')
  const flatten = text => { const keys = {}; flattenJson(JSON.parse(text), '', keys); return keys }
  fs.writeFileSync(d7file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { UserPromptSubmit: [{ command: 'a.sh' }] } }))
  const a = flatten(fs.readFileSync(d7file, 'utf8')), wholeA = digest(fs.readFileSync(d7file, 'utf8'))
  fs.writeFileSync(d7file, JSON.stringify({ permissions: { allow: ['Bash(rm:*)'] }, hooks: { UserPromptSubmit: [{ command: 'evil.sh' }] } }))
  const b = flatten(fs.readFileSync(d7file, 'utf8')), wholeB = digest(fs.readFileSync(d7file, 'utf8'))
  const d7changed = Object.keys(a).filter(key => a[key] !== b[key]).sort()
  fs.rmSync(d7dir, { recursive: true, force: true })
  const d7expected = ['hooks.UserPromptSubmit', 'permissions.allow']
  record('C3-1-value-change-under-an-unchanged-key-D7', wholeA !== wholeB && JSON.stringify(d7changed) === JSON.stringify(d7expected),
    { wholeFileChanged: wholeA !== wholeB, changed: d7changed, expected: d7expected })

  // ②③④ — one end-to-end run of this script over a fake home. The paths below are invented and
  // must never be narrowed: ④ is the control that proves a path-shaped key cannot reach an
  // artifact, and a fixture without paths in it would prove nothing.
  const root = fs.mkdtempSync('/tmp/l394-c3-')
  const fakeHome = path.join(root, 'home'), raw = path.join(root, 'raw'), side = path.join(root, 'side')
  for (const dir of [fakeHome, raw, side, path.join(fakeHome, '.codex'), path.join(fakeHome, '.grok')]) fs.mkdirSync(dir, { recursive: true })
  const GHOST = '/Users/ghost-l426/repos/private-thing'
  const GHOST2 = '/Users/ghost-l426/Documents/second dir'
  const env = {
    ...process.env,
    HOME: fakeHome,
    L394_RAW: raw,
    L394_SIDECAR_DIR: side,
    L394_SALT_FILE: path.join(root, 'salt'),
  }
  const claudeJson = state => JSON.stringify({
    numStartups: state.startups,
    projects: {
      [GHOST]: { hasTrustDialogAccepted: true, lastCost: 0.5 },
      ...(state.second ? { [GHOST2]: { hasTrustDialogAccepted: true } } : {}),
    },
    ...(state.second ? { arrived: 'now' } : { leaving: 'soon' }),
  }, null, 1)
  const codexToml = state => [`[projects."${GHOST}"]`, `trust_level = "${state.trust}"`, ''].join('\n')
  const grokToml = state => [`"${GHOST}" = true`, ...(state.second ? [`"${GHOST2}" = true`] : []), ''].join('\n')
  const write = state => {
    fs.writeFileSync(path.join(fakeHome, '.claude.json'), claudeJson(state))
    fs.writeFileSync(path.join(fakeHome, '.codex/config.toml'), codexToml(state))
    fs.writeFileSync(path.join(fakeHome, '.grok/trusted_folders.toml'), grokToml(state))
  }
  const self = fileURLToPath(import.meta.url)
  const run = stage => execFileSync(process.execPath, [self, stage], { encoding: 'utf8', env }).trim()

  write({ startups: 1, trust: 'untrusted', second: false })
  const beforeOut = run('before')
  write({ startups: 2, trust: 'trusted', second: true })
  const afterOut = run('after')
  const diffOut = run('diff')
  const report = JSON.parse(fs.readFileSync(path.join(raw, 'global-diff.json'), 'utf8'))
  const claude = report.files['.claude.json'] ?? {}
  const codex = report.files['.codex.config.toml'] ?? {}
  const grok = report.files['.grok.trusted_folders.toml'] ?? {}

  // ② a key appeared and a key disappeared, and both were reported — while `numStartups` moved
  //   under an unchanged name (① again, this time through the real pipeline) and
  //   `projects.<GHOST>.lastCost` did not move at all and so is named nowhere.
  record('C3-2-key-added-and-removed', claude.added?.includes('arrived') === true
    && JSON.stringify(claude.removed) === JSON.stringify(['leaving'])
    && JSON.stringify(claude.changed) === JSON.stringify(['numStartups'])
    && grok.added?.length === 1 && grok.added[0].startsWith('<p:'),
    { claudeAdded: claude.added, claudeRemoved: claude.removed, claudeChanged: claude.changed, grokAdded: grok.added })

  // ③ a trust key was added, and LIFE-410 F14's own classifier still calls it a trust key.
  const f14IsTrust = key => /hasTrustDialogAccepted$|^trusted|^projects\./.test(key)
  const trustAdded = (claude.added ?? []).filter(key => key.endsWith('.hasTrustDialogAccepted'))
  const codexKeys = [...(codex.added ?? []), ...(codex.changed ?? []), ...(codex.removed ?? [])]
  record('C3-3-trust-key-added-and-still-classified-as-trust', trustAdded.length === 1
    && trustAdded.every(f14IsTrust) && trustAdded.every(key => key.startsWith('projects.'))
    && codexKeys.length > 0 && codexKeys.every(f14IsTrust),
    { trustAdded, codexKeys, classifier: String(f14IsTrust) })

  // ④ nothing any of the three stages wrote names a path — by both prongs of the leak check, over
  //   the artifacts AND over the sidecar that is deliberately kept outside the repository.
  const leak = inspect([raw, side])
  record('C3-4-no-artifact-names-a-path', leak.hits.length === 0 && leak.filesScanned >= 4,
    { fixturePaths: [GHOST, GHOST2].map(p => p.length), filesScanned: leak.filesScanned, hits: leak.hits.slice(0, 10) })

  // The summary the gates assert on has to have counted all of this.
  record('C3-summary-counts-what-moved', report.summary.changedKeyPaths === 6
    && report.summary.changedFiles.length === 3 && report.summary.changedDirs.length === 0,
    { summary: report.summary, stdout: { before: beforeOut, after: afterOut, diff: diffOut.replace(/\n\s*/g, ' ') } })

  fs.rmSync(root, { recursive: true, force: true })
  const pass = results.every(entry => entry.pass)
  console.log(JSON.stringify({ controls: results, pass }, null, 1))
  if (!pass) process.exit(1)
}
