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
import fs from 'node:fs'
import os from 'node:os'
import { createHash, randomBytes } from 'node:crypto'

/** 01-criteria 용어: a key-path segment is path-form when it contains `/` or starts with `~`. */
export const isPathish = name => name.includes('/') || name.startsWith('~')

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
  return {
    digest,
    token,
    /** One key-path segment, or one TOML section part. Non-path names are kept verbatim. */
    segment: name => (isPathish(name) ? token(name) : name),
    /**
     * Machine output, or a bare path: every path in it, replaced. Two passes, absolute runs first
     * so the readable shape survives where it can. Not for prose — it would eat `app/scripts/…`.
     */
    text: value => String(value)
      .replace(ABSOLUTE_PATH, match => token(match))
      .replace(ANY_SLASHED_TOKEN, match => token(match)),
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
