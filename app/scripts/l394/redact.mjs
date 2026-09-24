// LIFE-426 — the redaction rule shared by the LIFE-394 collector and the LIFE-409/410 native gates.
//
// The collector flattens the user's provider configuration into `key path → salted value digest`.
// Values were never recoverable, but the key *paths* were plaintext, and in three of the collected
// files a key IS a local directory name (`~/.claude.json`'s `projects.<absolute path>.*`, the
// `[projects."<absolute path>"]` sections of `~/.codex/config.toml`, every key of
// `~/.grok/trusted_folders.toml`). Committing a snapshot committed the user's directory listing.
//
// One rule, in one place, so the collector and both gates redact identically: a *segment* that
// looks like a path becomes `<p:digest>` under the same salt the values use. The salt lives outside
// the repository, so the tokens are stable within a run — which is what lets `diff` still compare
// key for key — and inert outside it.
//
// **Which function to reach for (review V15).** A complete path, known to be exactly one path, goes
// through `token` — the whole string becomes one `<p:…>` and nothing of it can be left standing.
// `text` is for strings whose boundaries are *not* known: a process argv, the output of a resolver,
// a screen excerpt. It finds the paths inside such a string, which means a path containing a space
// ends the run halfway and the middle name (`Work TOPSECRET Files`, with no `/` on it) survives as
// a bare word. That is a loss `text` cannot avoid and `token` does not have, so every caller that
// already holds one whole path must use `token`; `text` is the fallback for text, never for a path.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

/** 01-criteria 용어: a key-path segment is path-form when it contains `/` or starts with `~`. */
export const isPathish = name => name.includes('/') || name.startsWith('~')

/**
 * Whether a *name* has to be redacted, which is not the same question as whether it is itself
 * path-form. A finished key path is read back by splitting it on `.`, so a name that is not
 * path-form as a whole can still produce a path-form segment once it is joined into one: the key
 * `prefix.~secret` yields the segment `~secret` (review V4 — the checker counted it, the redactor
 * did not). So the test is applied to every `.`-separated part of the name, and a hit redacts the
 * *whole* original name — splitting it would cut an absolute path, which carries dots of its own,
 * in the wrong places. This strictly contains the old rule: a `/` anywhere, or a leading `~`,
 * still lands in one of the parts.
 */
export const hasPathishPart = name => name.split('.').some(isPathish)

/**
 * An absolute or `~`-rooted path inside machine output (a process argv, the output of `command -v`).
 * Redacting it as one run keeps the shape of the line — `-c source <p:…> && claude` still says what
 * the process was doing.
 */
const ABSOLUTE_PATH = /(?<![\w.~-])(?:~\/|\/)[^\s'"`]*/g
/**
 * The sweep behind it. A path with a space in it stops the run above halfway through
 * (`/Users/x/Library/Application Support/claude` leaves `Support/claude` standing), and that
 * remainder is still a directory name — C5's own positive control caught exactly this. So anything
 * still carrying a `/` afterwards goes too. It is deliberately blunt: this runs over argv and
 * resolver output, where every `a/b` token IS a path, never over prose.
 */
const ANY_SLASHED_TOKEN = /[^\s'"`]*\/[^\s'"`]*/g

/**
 * Build the redactor for one run. `saltFile` is the same file the collector digests values with,
 * and is created (0600, outside the repository) the first time it is needed.
 */
export function redactor(saltFile) {
  if (!fs.existsSync(saltFile)) fs.writeFileSync(saltFile, randomBytes(32).toString('hex'), { mode: 0o600 })
  const salt = fs.readFileSync(saltFile, 'utf8').trim()
  const digest = value => createHash('sha256').update(salt).update('\0').update(String(value)).digest('hex').slice(0, 16)
  const token = value => `<p:${digest(value)}>`
  const textOf = value => String(value)
    .replace(ABSOLUTE_PATH, match => token(match))
    .replace(ANY_SLASHED_TOKEN, match => token(match))
  return {
    digest,
    token,
    /**
     * One key-path segment, or one TOML section part: redacted whole when any `.`-separated part
     * of it is path-form (`hasPathishPart`). Non-path names are kept verbatim.
     */
    segment: name => (hasPathishPart(name) ? token(name) : name),
    /**
     * Machine output, or a bare path: every path in it, replaced. Two passes, absolute runs first
     * so the readable shape survives where it can. Not for prose — it would eat `app/scripts/…`.
     */
    text: textOf,
    /**
     * A path as a gate may record it: its own file name, which is never personal, and the whole
     * path as one token (review V15 — this used to be `text`, which leaves the middle name of a
     * path with a space in it standing). Both native gates call this one, so the rule and the
     * fixture that holds it live together rather than in two copies.
     */
    describePath: file => ({ name: path.basename(file), path: token(file) }),
    /**
     * The `foregroundExecutable()` record — `{ expected, observed[], match, shellPid }` — as it is
     * allowed to be written down (review V16). The same install realpath that `providerPath`
     * tokenises sits in `expected`, `match.executable`, `match.realpath` and every
     * `observed[].executable/realpath`, and `observed[].argv` carries other tools' install paths.
     *
     * Each path field is one whole path, so it goes through `token`. An argv element here is not
     * the `ps args` string N13 deals with — `terminal show` reports argv as a real array, so an
     * element that is path-form is *also* one whole path and is tokenised whole; only elements
     * that are not paths fall back to `text` (a flag is unchanged by it, and an option that has a
     * path glued inside it still gets that path replaced). Tokenising the element is what makes
     * the fixture below hold: `--add-dir /Users/…/repo TOPSECRET` arrives as its own element, and
     * `text` alone would leave `TOPSECRET` standing exactly as V2 and V14 described.
     * `pid`, `name`, `comm` and `shellPid` stay —
     * `name` is the version directory's own name, which is how C5 compares two installs, and a pid
     * is not a place. The gate's assertions have already run inside `foregroundExecutable` against
     * the unredacted values, so redacting here cannot change what the gate concluded.
     *
     * `match` is the same object as one of `observed`, so the redacted `match` is the redacted
     * entry, found by position rather than redacted a second time into a separate copy.
     */
    executable: record => {
      if (record === null || typeof record !== 'object') return record
      const keep = value => value === null || value === undefined
      const one = entry => ({
        ...entry,
        argv: Array.isArray(entry.argv)
          ? entry.argv.map(item => (isPathish(String(item)) ? token(String(item)) : textOf(item)))
          : entry.argv,
        executable: keep(entry.executable) ? entry.executable : token(entry.executable),
        realpath: keep(entry.realpath) ? entry.realpath : token(entry.realpath),
      })
      const listed = record.observed ?? []
      const observed = listed.map(one)
      const at = listed.indexOf(record.match)
      return {
        ...record,
        expected: keep(record.expected) ? record.expected : token(record.expected),
        observed,
        match: at >= 0 ? observed[at] : keep(record.match) ? record.match : one(record.match),
      }
    },
    /**
     * How a collected file is named in every artifact. The user's home prefix is dropped rather
     * than written as `~/` (which the leak check counts), and the remaining separators become dots
     * so the label is not itself a path-form key: `~/.claude/settings.json` → `.claude.settings.json`.
     */
    label: file => {
      const home = os.homedir()
      if (!file.startsWith(home + '/')) return token(file)
      return file.slice(home.length + 1).replaceAll('/', '.')
    },
  }
}
