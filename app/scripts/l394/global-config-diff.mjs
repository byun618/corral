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
// `diff` binds the sidecar to the snapshot it belongs to, twice over: the sidecar's key list must
// re-digest to the snapshot's `keysDigest`, and its `[key, value digest]` pairs to the snapshot's
// `entriesDigest`. The key list alone accepted any sidecar carrying the same keys under other
// values — the `after` sidecar standing in for the `before` one gave exit 0 and an empty diff
// (review V3). A missing or mismatched sidecar is a hard failure, never an empty diff — an empty
// diff is what the gates read as "nothing moved".
//
// The salt lives outside the repo (L394_SALT_FILE, default /tmp/l394-claude-salt) so the committed
// digests, value and path alike, cannot be inverted even for low-entropy inputs.
//
// `selftest` is the positive control: D7's value change, key add/remove, a trust key, an
// end-to-end run over a fake home whose keys are absolute paths, and — added in review round 1 —
// the TOML quoted-key forms (V1), a JSON key whose path-form part is behind a dot (V4), a
// substituted sidecar (V3), a `~`-prefixed hooks entry (V12) and the private sidecar directory
// (V13). Every fixture carries a marker that must not appear in any artifact, because a
// half-redacted directory name is a leak the path-shaped check cannot see. It exits non-zero when
// any control fails (C3/C4/D25).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
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

/**
 * A TOML dotted key, read as TOML defines it (review V1). The first reader toggled on `"` alone,
 * so a literal-string key (`[projects.'/Users/x/repo.name']`) had the dot *inside* the quotes read
 * as a separator, and `\u002f` was never seen as the `/` it stands for. Either way a piece of a
 * directory name reached the diff and the sidecar while the leak check — which sees only the text
 * it is handed, not where the text came from — reported nothing.
 *
 * Reads bare keys, basic strings (`"…"`, with `\b \t \n \f \r \" \\ \uXXXX \UXXXXXXXX`) and
 * literal strings (`'…'`, no escapes), separated by dots outside quotes. Returns the decoded parts
 * and what follows them, or `null` for syntax it cannot read — a caller that gets `null` redacts
 * the whole raw line as one token rather than emitting a piece of it.
 */
const BARE_KEY = /[A-Za-z0-9_-]/
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
const readEscape = (text, index) => {
  const code = text[index + 1]
  if (code !== undefined && Object.hasOwn(ESCAPES, code)) return { value: ESCAPES[code], next: index + 2 }
  if (code !== 'u' && code !== 'U') return null
  const width = code === 'u' ? 4 : 8
  const hex = text.slice(index + 2, index + 2 + width)
  if (hex.length !== width || /[^0-9a-fA-F]/.test(hex)) return null
  const point = parseInt(hex, 16)
  if (point > 0x10ffff) return null
  return { value: String.fromCodePoint(point), next: index + 2 + width }
}
const readTomlKey = text => {
  const parts = []
  let index = 0
  for (;;) {
    while (text[index] === ' ' || text[index] === '\t') index++
    const quote = text[index]
    if (quote === '"' || quote === "'") {
      index++
      let value = ''
      for (;;) {
        const character = text[index]
        if (character === undefined || character === '\n') return null
        if (character === quote) { index++; break }
        if (quote === '"' && character === '\\') {
          const escape = readEscape(text, index)
          if (escape === null) return null
          value += escape.value
          index = escape.next
          continue
        }
        value += character
        index++
      }
      parts.push(value)
    } else {
      let value = ''
      while (index < text.length && BARE_KEY.test(text[index])) { value += text[index]; index++ }
      if (value === '') return null
      parts.push(value)
    }
    while (text[index] === ' ' || text[index] === '\t') index++
    if (text[index] !== '.') return { parts, rest: text.slice(index) }
    index++
  }
}
/** Each decoded part through `redact.segment`, which redacts the whole part when it is path-form. */
const redactParts = parts => parts.map(part => redact.segment(part)).join('.')

// Minimal TOML key-path reader: enough to notice a changed value under an unchanged key.
// Lines it cannot parse are digested positionally so nothing is silently dropped.
const flattenToml = (text, sink) => {
  let section = ''
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    if (trimmed.startsWith('[')) {
      const doubled = trimmed.startsWith('[[')
      const closing = doubled ? ']]' : ']'
      const read = readTomlKey(trimmed.slice(doubled ? 2 : 1))
      const after = read === null ? '' : read.rest.trim()
      const tail = after.startsWith(closing) ? after.slice(closing.length).trim() : null
      const closed = read !== null && tail !== null && (tail === '' || tail.startsWith('#'))
      // A header this reader cannot take apart is redacted whole. Emitting the part it *did*
      // manage to read is how a directory name used to escape (V1).
      section = closed ? redactParts(read.parts) : redact.token(trimmed)
      sink[`${section}.<section>`] = digest(trimmed)
      return
    }
    const read = readTomlKey(trimmed)
    const rest = read === null ? '' : read.rest.trimStart()
    if (read !== null && rest.startsWith('=')) {
      const key = redactParts(read.parts)
      sink[section ? `${section}.${key}` : key] = digest(rest.slice(1).trim())
      return
    }
    sink[`#line${index + 1}`] = digest(trimmed)
  })
}

/** The trust keys, by the same shape LIFE-410 F14 classifies with. Redaction preserves both ends. */
const isTrustKey = key => /hasTrustDialogAccepted$|^trusted/.test(key)

/**
 * The two digests that bind a snapshot to its sidecar. The key list alone accepts any sidecar with
 * the same key set, whatever the values under it — copying the `after` sidecar over the `before`
 * one produced exit 0 and an empty diff, which the gates read as "nothing moved" (review V3). So
 * the snapshot also records a digest over the sorted `[key, value digest]` pairs: same keys with
 * other values no longer match. Both are kept — the key-set digest still says *which* of the two
 * is wrong when they disagree.
 */
const keysDigestOf = names => digest(JSON.stringify(names))
const entriesDigestOf = (names, keys) => digest(JSON.stringify(names.map(name => [name, keys[name]])))

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
    files[key] = {
      exists: true,
      whole: digest(text),
      keyCount: names.length,
      trustKeyCount: names.filter(isTrustKey).length,
      keysDigest: keysDigestOf(names),
      entriesDigest: entriesDigestOf(names, keys),
    }
    // The sidecar holds the map and nothing else: a digest stored *beside* the thing it describes
    // would only ever be re-derived from it, which is no check at all (V3, claude #6).
    sidecar[key] = { keys }
  }
  const dirs = {}
  // Entry names go through the same rule as a key segment. They cannot hold a `/`, so in practice
  // this only catches a name that starts with `~` — an editor backup in a hooks directory would
  // otherwise read as a leak to the check while being none (V12, claude #7).
  for (const dir of DIRS) dirs[redact.label(dir)] = fs.existsSync(dir) ? fs.readdirSync(dir).sort().map(entry => redact.segment(entry)) : null
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
    const names = held?.keys ? Object.keys(held.keys).sort() : null
    // Both digests are recomputed from the map itself. The key set says the sidecar holds the
    // right keys; the entries say it holds the right values under them (V3).
    const keysMatch = names !== null && keysDigestOf(names) === detail.keysDigest
    const entriesMatch = names !== null && entriesDigestOf(names, held.keys) === detail.entriesDigest
    if (!keysMatch || !entriesMatch) {
      console.error(`global-config-diff: the ${which} key sidecar does not belong to global-${which}.json (${label}).`)
      console.error(`Key set ${keysMatch ? 'matches' : 'does not match'}; per-key values ${entriesMatch ? 'match' : 'do not match'}.`)
      console.error('Re-run before/after; a diff computed from a foreign sidecar would be a claim about another run.')
      process.exit(3)
    }
  }
  return stored
}

/**
 * The marker every review-round-1 fixture carries inside a path-shaped key. It is the assertion
 * that a path-shaped check cannot make: a name left *half* redacted still looks like nothing.
 */
const FIXTURE_MARK = 'TOPSECRET'

/**
 * One fixture case: a fake home holding one file, driven `before` → mutate → `after` → `diff`
 * through this very script in child processes, the way the gates drive it. Returns the exit codes
 * (so a control can assert the hard failure of exit 3), what the diff reported, whether the marker
 * survived into any artifact or into the sidecar, and the leak count over both.
 *
 * `spawnSync`, not `execFileSync`: a control whose expected outcome is a non-zero exit cannot be
 * written with a call that throws on one.
 */
const collect = ({ id, file, before, after, prepare, mutateSidecar }) => {
  const root = fs.mkdtempSync(`/tmp/l394-c3-${id}-`)
  const home = path.join(root, 'home'), raw = path.join(root, 'raw'), side = path.join(root, 'side')
  fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true })
  fs.mkdirSync(raw, { recursive: true })
  prepare?.(home)
  const env = { ...process.env, HOME: home, L394_RAW: raw, L394_SIDECAR_DIR: side, L394_SALT_FILE: path.join(root, 'salt') }
  const self = fileURLToPath(import.meta.url)
  const stage = name => spawnSync(process.execPath, [self, name], { encoding: 'utf8', env })
  fs.writeFileSync(path.join(home, file), before)
  const first = stage('before')
  fs.writeFileSync(path.join(home, file), after)
  const second = stage('after')
  mutateSidecar?.(side)
  const third = stage('diff')
  const diffFile = path.join(raw, 'global-diff.json')
  const diffWritten = fs.existsSync(diffFile)
  const report = diffWritten ? JSON.parse(fs.readFileSync(diffFile, 'utf8')) : null
  const keyPaths = report
    ? Object.values(report.files).flatMap(entry => [...(entry.added ?? []), ...(entry.removed ?? []), ...(entry.changed ?? [])])
    : []
  const contents = dir => (fs.existsSync(dir)
    ? fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n')
    : '')
  const text = contents(raw) + '\n' + contents(side)
  const leak = inspect([raw, ...(fs.existsSync(side) ? [side] : [])])
  fs.rmSync(root, { recursive: true, force: true })
  return {
    id,
    exits: [first.status, second.status, third.status],
    stderr: (third.stderr ?? '').trim().split('\n')[0]?.slice(0, 120) ?? '',
    diffWritten,
    keyPaths,
    changedKeyPaths: report?.summary?.changedKeyPaths ?? null,
    markerSurvives: text.includes(FIXTURE_MARK) || text.includes('ghost-l426'),
    leakHits: leak.hits.length,
  }
}

if (mode === 'before' || mode === 'after') {
  const { sidecar, ...taken } = snapshot()
  fs.writeFileSync(path.join(out, `global-${mode}.json`), JSON.stringify(taken, null, 2) + '\n')
  fs.mkdirSync(sidecarDir, { recursive: true, mode: 0o700 })
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
 * The positive controls (01-criteria C3). ① a value change under an unchanged key — D7, the
 * finding this collector exists for; ② a key added and a key removed; ③ a trust key added, and
 * still classified as trust after redaction (C4); ④ a fake home whose JSON and TOML keys are
 * absolute paths, run end to end, with every artifact leak-checked — and beside it the oracle
 * that proves the check still detects those paths when they are *not* redacted (V9); ⑤ the
 * `summary` the gates assert on. Review round 1 adds: ⑥ the TOML quoted-key forms (V1), ⑦ a JSON
 * key whose path-form part sits behind a dot (V4), ⑧ a substituted sidecar (V3), ⑨ a
 * `~`-prefixed hooks entry (V12), ⑩ the sidecar directory's mode (V13).
 *
 * Everything but ① drives the real script in child processes over a fake `HOME`, so what is under
 * test is the pipeline that the gates run, not a re-implementation of it.
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
  // `side` is deliberately absent: the collector creates it, which is what ⑩ measures the mode of.
  for (const dir of [fakeHome, raw, path.join(fakeHome, '.codex'), path.join(fakeHome, '.grok')]) fs.mkdirSync(dir, { recursive: true })
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
  //   The negative control beside it is the oracle: the same fixture *before* redaction, written
  //   to a file of its own, must come back with hits. Without it `hits.length === 0` also passes
  //   when `inspect()` has stopped looking at anything (review V9).
  const leak = inspect([raw, side])
  const unredacted = path.join(root, 'negative-control.json')
  fs.writeFileSync(unredacted, JSON.stringify({ projects: { [GHOST]: { hasTrustDialogAccepted: true }, [GHOST2]: {} } }, null, 1))
  const oracle = inspect([unredacted])
  record('C3-4-no-artifact-names-a-path', leak.hits.length === 0 && leak.filesScanned >= 4 && oracle.hits.length > 0,
    { fixturePaths: [GHOST, GHOST2].map(p => p.length), filesScanned: leak.filesScanned, hits: leak.hits.slice(0, 10),
      negativeControl: { file: path.basename(unredacted), hits: oracle.hits.length } })

  // The summary the gates assert on has to have counted all of this.
  record('C3-summary-counts-what-moved', report.summary.changedKeyPaths === 6
    && report.summary.changedFiles.length === 3 && report.summary.changedDirs.length === 0,
    { summary: report.summary, stdout: { before: beforeOut, after: afterOut, diff: diffOut.replace(/\n\s*/g, ' ') } })

  const sidecarMode = fs.statSync(side).mode & 0o777
  fs.rmSync(root, { recursive: true, force: true })

  // ⑥~⑨ — the review-round-1 fixtures. Each one is a whole before → after → diff over a fake home
  //   of its own, driven through this script in a child process, and each carries MARK inside a
  //   path-shaped key. MARK is the assertion that matters: a *half*-redacted directory name (the
  //   `TOPSECRET` left standing after the reader mistook a quote or a dot) is invisible to a check
  //   that looks for path shapes, so what is asserted is the marker's absence from every artifact
  //   and from the sidecar, not just a leak count of zero.
  const MARK = FIXTURE_MARK
  const GHOST_DIR = `/Users/ghost-l426/repo.${MARK}`
  const shape = entry => ({ id: entry.id, exits: entry.exits, changedKeyPaths: entry.changedKeyPaths,
    markerSurvives: entry.markerSurvives, leakHits: entry.leakHits, keyPaths: entry.keyPaths })
  const clean = entry => JSON.stringify(entry.exits) === JSON.stringify([0, 0, 0])
    && entry.markerSurvives === false && entry.leakHits === 0

  // ⑥ V1 — every one of these is valid TOML and every one keys a section by a directory. The
  //   single-quoted, escaped-quote and `\u002f` forms each used to leave part of the name behind.
  //   `changedKeyPaths >= 1` is the other half: redacting a header the reader cannot take apart
  //   must not quietly drop the file from the diff.
  const tomlSections = [
    ['double-quoted', `[projects."${GHOST_DIR}"]`],
    ['single-quoted', `[projects.'${GHOST_DIR}']`],
    ['escaped-quote', `[projects."/Users/ghost-l426/repo\\".${MARK}"]`],
    ['unicode-escape', `[projects."\\u002fUsers\\u002fghost-l426\\u002f${MARK}"]`],
  ].map(([name, header]) => collect({
    id: `toml-${name}`, file: '.codex/config.toml',
    before: `${header}\ntrust_level = "trusted"\n`,
    after: `${header}\ntrust_level = "untrusted"\n`,
  }))
  const tomlPairs = [
    ['kv-double-quoted', `"${GHOST_DIR}"`],
    ['kv-single-quoted', `'${GHOST_DIR}'`],
  ].map(([name, key]) => collect({
    id: `toml-${name}`, file: '.grok/trusted_folders.toml',
    before: `${key} = true\n`, after: `${key} = false\n`,
  }))
  const tomlCases = [...tomlSections, ...tomlPairs]
  record('C3-6-toml-quoted-path-keys-leave-no-name-behind',
    tomlCases.every(entry => clean(entry) && entry.changedKeyPaths >= 1),
    { cases: tomlCases.map(shape) })

  // ⑦ V4 — a key that is not path-form as a whole but yields a path-form segment once it is
  //   joined into a key path. `dot-tilde` is the case the checker counted and the redactor did not.
  const jsonCases = [
    ['dot-tilde', `prefix.~${MARK}`],
    ['dot-slash', `prefix.b/${MARK}`],
    ['tilde-root', `~/${MARK}`],
  ].map(([name, key]) => collect({
    id: `json-${name}`, file: '.claude.json',
    before: JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true } } }),
    after: JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: false } } }),
  }))
  const tokenisedKey = /^projects\.<p:[0-9a-f]{16}>\.hasTrustDialogAccepted$/
  record('C3-7-a-json-key-with-a-path-form-part-is-tokenised',
    jsonCases.every(entry => clean(entry) && entry.changedKeyPaths === 1 && entry.keyPaths.every(key => tokenisedKey.test(key))),
    { cases: jsonCases.map(shape) })

  // ⑧ V3 — the sidecar of another snapshot. Same keys, other values: the key-set digest matched,
  //   so the diff used to come back empty with exit 0, and an empty diff is what F13 reads as
  //   "nothing moved". The control beside it proves the same fixture does report its one change.
  const sidecarBefore = JSON.stringify({ numStartups: 1, projects: { '/Users/ghost-l426/a': { hasTrustDialogAccepted: true } } })
  const sidecarAfter = JSON.stringify({ numStartups: 2, projects: { '/Users/ghost-l426/a': { hasTrustDialogAccepted: true } } })
  const substituted = collect({
    id: 'sidecar-substituted', file: '.claude.json', before: sidecarBefore, after: sidecarAfter,
    mutateSidecar: side => {
      const [held, taken] = ['before', 'after'].map(which => fs.readdirSync(side).find(name => name.endsWith(`-${which}.json`)))
      fs.copyFileSync(path.join(side, taken), path.join(side, held))
    },
  })
  const sidecarControl = collect({ id: 'sidecar-control', file: '.claude.json', before: sidecarBefore, after: sidecarAfter })
  record('C3-8-a-sidecar-of-another-snapshot-is-refused',
    substituted.exits[2] === 3 && substituted.changedKeyPaths === null && substituted.diffWritten === false
    && sidecarControl.exits[2] === 0 && sidecarControl.changedKeyPaths === 1,
    { substituted: { ...shape(substituted), diffWritten: substituted.diffWritten, stderr: substituted.stderr },
      control: shape(sidecarControl) })

  // ⑨ V12 — a hooks entry whose name starts with `~`. It is not a path, but the check counts it as
  //   path-form, so an editor backup in a hooks directory would read as a leak that is none.
  const dirsCase = collect({
    id: 'dirs-tilde-entry', file: '.claude.json',
    before: JSON.stringify({ numStartups: 1 }), after: JSON.stringify({ numStartups: 2 }),
    prepare: home => {
      fs.mkdirSync(path.join(home, '.claude/hooks'), { recursive: true })
      fs.writeFileSync(path.join(home, `.claude/hooks/~backup-${MARK}.sh`), '#!/bin/sh\n')
    },
  })
  record('C3-9-a-tilde-prefixed-hooks-entry-is-tokenised', clean(dirsCase), { case: shape(dirsCase) })

  // ⑩ V13 — the sidecar lives outside the repository, and the directory the collector creates for
  //   it is the user's alone. The files were already 0600; the directory was whatever umask said.
  record('C3-10-the-sidecar-directory-is-private', sidecarMode === 0o700,
    { mode: sidecarMode.toString(8), expected: '700' })

  // ⑪ V15 — a complete path goes through `token`, not `text`. `describePath` is the function both
  //   native gates record an install with; `text` left the middle name of a path with a space in
  //   it standing (`Work TOPSECRET Files`), which has no path shape and so no checker sees it.
  const spacedInstall = `/Users/ghost-l426/Work ${MARK} Files/bin/claude`
  const described = redact.describePath(spacedInstall)
  record('C3-11-a-full-path-with-a-space-is-one-token',
    /^<p:[0-9a-f]{16}>$/.test(described.path) && !JSON.stringify(described).includes(MARK)
    && described.name === 'claude' && redact.text(spacedInstall).includes(MARK),
    { described, whatTextWouldHaveLeft: redact.text(spacedInstall).includes(MARK) })

  // ⑫ V16 — the `foregroundExecutable()` record is redacted before it is written down. The same
  //   install realpath `providerPath` tokenises sat in `expected`/`match`/`observed[]` in plain
  //   text, and `observed[].argv` carried other tools' install paths.
  const executableEntry = {
    pid: 1,
    name: '2.1.0',
    argv: ['claude', '--add-dir', `/Users/ghost-l426/repo ${MARK}`],
    comm: 'claude',
    executable: `/Users/ghost-l426/${MARK} dir/versions/2.1.0`,
    realpath: `/Users/ghost-l426/${MARK} dir/versions/2.1.0`,
  }
  const executableRecord = {
    expected: `/Users/ghost-l426/${MARK} dir/versions/2.1.0`,
    observed: [executableEntry],
    match: executableEntry,
    shellPid: 0,
  }
  const redactedExecutable = redact.executable(executableRecord)
  const executableText = JSON.stringify(redactedExecutable)
  record('C3-12-the-foreground-executable-record-names-no-path',
    !executableText.includes(MARK) && !executableText.includes('/Users/')
    && /^<p:[0-9a-f]{16}>$/.test(redactedExecutable.expected)
    && redactedExecutable.match === redactedExecutable.observed[0]
    && redactedExecutable.observed[0].name === '2.1.0'
    && redactedExecutable.observed[0].comm === 'claude'
    && redactedExecutable.observed[0].pid === 1
    && redactedExecutable.shellPid === 0,
    { record: redactedExecutable,
      markerSurvives: executableText.includes(MARK),
      keptForC5: { name: redactedExecutable.observed[0].name, comm: redactedExecutable.observed[0].comm } })

  const pass = results.every(entry => entry.pass)
  console.log(JSON.stringify({ controls: results, pass }, null, 1))
  if (!pass) process.exit(1)
}
