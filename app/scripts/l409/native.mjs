// LIFE-409 gate ② — the native-execution gate (00-analysis §7.3).
//
// The pane this binds an attempt to runs the user's own natively installed claude, started in a
// throwaway git directory and never prompted. The sequence is F3 (identity) → F2 (restart) →
// F5 (the pane is closed and the attempt becomes unknown), with the global provider config
// digested before and after so F13 can say what, if anything, moved.
//
// Nothing is submitted to the provider: no --prompt, no terminal send, no answer to any dialog.
//
// r1 (R6): the gate now waits for the provider to leave `launching`, resolves the pane's foreground
// executable through `ps` and compares it with the realpath of the user's own install, and reads
// the screen once to see which provider is on it. `native-negative.mjs` runs the same three checks
// against a fake `claude` that exits immediately and records that each of them fails there.
//
// LIFE-426: nothing this gate records names a local path. The collector's key paths arrive already
// redacted (`app/scripts/l394/redact.mjs`), and the two places this gate adds paths of its own —
// the head of another `claude` process's argv in N13, and the install this gate measured — are
// redacted under the same salt the collector digests with. N13 moved to `attribution.mjs` so its
// failure-only path can be fed a process list and leak-checked without failing F13 to see it
// (`node app/scripts/l409/attribution.mjs selftest`, 01-criteria C5).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixture } from './lib.mjs'
import { redactor } from '../l394/redact.mjs'
import { attribution } from './attribution.mjs'
import { differences, EXCLUDED } from './compare.mjs'
import { LIVE_PHASES, foregroundExecutable, screenIdentifiesProvider, waitForLaunch } from './native-checks.mjs'

const CLAUDE = process.env.L409_NATIVE_CLAUDE ?? path.join(os.homedir(), '.local/bin/claude')
assert(fs.existsSync(CLAUDE), `The native provider is expected at ${CLAUDE}`)
const version = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).trim()

const DIFF_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../l394/global-config-diff.mjs')
const SALT_FILE = process.env.L409_SALT_FILE ?? '/tmp/l409-claude-salt'
// The same salt the collector uses, so a path this file redacts and the same path inside a key
// path redact to the same token and can still be compared.
const redact = redactor(SALT_FILE)
/** A path as it may be recorded: its own file name, which is never personal, and a salted token. */
const describePath = file => ({ name: path.basename(file), path: redact.text(file) })

const f = await fixture('native', { expectedChecks: 7 })
// R6, and a finding of its own: `claude` on this machine resolves to an npm-global copy under nvm
// *before* the user's own launcher, so r0's gate measured `~/.local/bin/claude --version` in one
// place and ran a different install in the pane. The fixture's PATH (fixture-local, nothing global
// is touched) puts the launcher's directory first, so the pane runs the install this gate is about.
const NATIVE_BIN = path.dirname(CLAUDE)
f.base.PATH = NATIVE_BIN + ':' + f.base.PATH
f.env.PATH = f.base.PATH
const resolution = execFileSync('/bin/sh', ['-c', 'command -v claude; which -a claude'], { encoding: 'utf8', env: f.base }).trim()
let runtime
/** The LIFE-394 collector, writing into this run's raw directory under its own salt. */
const diff = mode => execFileSync(process.execPath, [DIFF_SCRIPT, mode], {
  encoding: 'utf8',
  env: { ...process.env, L394_RAW: f.raw, L394_SALT_FILE: SALT_FILE },
}).trim()

try {
  // The narrowest possible window: the snapshot is taken immediately before the provider starts.
  const before = diff('before')
  await f.startBackend()
  runtime = await f.serve()
  await f.registerRepo()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-409 gate 2 — native provider pane'])
  const task = await f.cli(['orchestration', 'task-create', '--spec', 'bound to a native claude pane', '--title', 'native'])
  const taskId = task.result.task.id

  const created = await f.check('GATE2-launch-the-native-provider-without-prompting-it', async () => {
    const response = await f.cli(['terminal', 'create', '--worktree', f.repo, '--title', 'l409-native', '--agent', 'claude'], { timeout: 180000 })
    assert.equal(response.result.stages.agent.status, 'completed', JSON.stringify(response.result.stages))
    assert.equal(response.result.stages.prompt.status, 'not_started', 'no body may be submitted at this gate')
    assert.equal(response.result.agent.kind, 'claude')
    return response
  })
  const handle = created.result.terminal.handle

  const launched = await f.check('GATE2-R6-the-pane-really-runs-the-users-own-claude', async () => {
    // (1) the provider comes up. `blocked` is a pass: a trust screen is a running provider, and
    //     this gate never answers a dialog. `exited` or a timeout fails the gate outright.
    const phase = await waitForLaunch(f, handle)
    assert.ok(LIVE_PHASES.includes(phase.phase), phase.phase)
    // (2) the process in that pane is the user's installed executable, by realpath.
    const executable = await foregroundExecutable(f, handle, CLAUDE)
    // (3) the screen says so too — one read, no input.
    const screen = await screenIdentifiesProvider(f, handle, /Claude Code|claude\.ai|Welcome to Claude|2\.1\.252/i, 'native-screen')
    return { phase, executable, screen, providerVersion: version, providerPath: describePath(fs.realpathSync(CLAUDE)), pathResolution: redact.text(resolution) }
  })

  let dispatched
  await f.check('GATE2-F3-the-attempt-records-the-native-pane-and-its-agent', async () => {
    const shown = await f.cli(['terminal', 'show', '--terminal', handle], { timeout: 60000 })
    dispatched = await f.cli(['orchestration', 'dispatch', '--task', taskId, '--to', handle], { timeout: 60000 })
    const record = dispatched.result.dispatch
    assert.deepEqual(
      { epoch: record.target.epoch, ptyId: record.target.ptyId, paneId: record.target.paneId },
      { epoch: shown.result.terminal.epoch, ptyId: shown.result.terminal.ptyId, paneId: shown.result.terminal.paneId },
    )
    assert.equal(record.target.handle, handle)
    assert.notEqual(record.agent, null, 'a managed native provider must produce an agent snapshot')
    assert.equal(record.agentAbsenceReason, null)
    // The stored snapshot is the identity half of what terminal show reported, field for field.
    for (const field of ['kind', 'name', 'requestedModel', 'requestedEffort', 'requestedAdvisor', 'resolvedModel', 'resolvedAdvisor', 'sessionId', 'sessionIdSource'])
      assert.deepEqual([field, record.agent[field]], [field, shown.result.agent[field]])
    assert.deepEqual(record.agent.argv, shown.result.agent.argv)
    assert.equal(record.attempt, 1)
    assert.equal(dispatched.result.task.status, 'dispatched')
    assert.ok(LIVE_PHASES.includes(record.agent.phase) || record.agent.phase === 'launching',
      `an unexpected phase was frozen into the record: ${record.agent.phase}`)
    return { providerVersion: version, providerPath: describePath(fs.realpathSync(CLAUDE)), storedPhase: record.agent.phase, launchedPhase: launched.phase.phase, shown, dispatched }
  })

  const snapshot = async () => ({
    runCurrent: await f.cli(['orchestration', 'run-current']),
    taskList: await f.cli(['orchestration', 'task-list']),
    dispatchShow: await f.cli(['orchestration', 'dispatch-show', '--id', dispatched.result.dispatch.id]),
  })
  await snapshot() // warm the reconcile record
  const baseline = await snapshot()
  const baselineDigest = f.stateDigest()

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    await f.check(`GATE2-F2-${signal}-restart-keeps-the-native-binding`, async () => {
      const restarted = await f.restart(runtime, signal)
      runtime = restarted.child
      const after = await snapshot()
      for (const key of Object.keys(baseline)) assert.deepEqual(differences(baseline[key], after[key]), [], `${key} changed across ${signal}`)
      assert.equal(after.dispatchShow.result.terminal.live, true, 'the provider pane outlives the runtime')
      assert.equal(f.stateDigest(), baselineDigest)
      return { signal, runtimeId: restarted.after.runtimeId, instanceIdBefore: restarted.before.instanceId, instanceIdAfter: restarted.after.instanceId, excluded: EXCLUDED }
    })
  }

  await f.check('GATE2-F5-closing-the-native-pane-makes-the-attempt-unknown', async () => {
    await f.cli(['terminal', 'close', '--terminal', handle], { timeout: 60000 })
    const shown = await f.cli(['orchestration', 'dispatch-show', '--id', dispatched.result.dispatch.id])
    assert.equal(shown.result.terminal.live, false)
    assert.equal(shown.result.terminal.source, 'observation')
    assert.equal(shown.result.terminal.reason, 'pane_gone')
    assert.equal(shown.result.dispatch.status, 'unknown')
    assert.equal(shown.result.dispatch.settledBy, 'reconcile')
    // Reading it again touches no backend: the attempt was already settled when that call started.
    const fromRecord = await f.cli(['orchestration', 'dispatch-show', '--id', dispatched.result.dispatch.id])
    assert.equal(fromRecord.result.terminal.source, 'record')
    assert.equal(fromRecord.result.terminal.live, null)
    assert.equal(shown.result.task.status, 'dispatched', 'the Task is never settled by an observation')
    // The identity of the dead attempt, including its agent snapshot, is still on record.
    assert.equal(shown.result.dispatch.agent.kind, 'claude')
    const settled = await f.cli(['orchestration', 'task-update', '--id', taskId, '--status', 'failed'])
    assert.equal(settled.result.task.status, 'failed')
    assert.equal(settled.result.dispatch, null)
    return { shown, fromRecord, settled }
  })

  const after = diff('after')
  const reported = diff('diff')
  f.record('state-after-native', f.stateJson())
  const summary = JSON.parse(fs.readFileSync(path.join(f.raw, 'global-diff.json'), 'utf8')).summary
  // R6(4): F13 is asserted, not merely printed. r0 wrote whatever the collector found into Markdown
  // and exited 0 either way, so "the diff was zero" rested on someone reading the file.
  await f.check('GATE2-F13-the-users-global-provider-config-did-not-move', async () => {
    // N13: the assertion is unchanged — a non-zero diff fails the gate. What is new is that the
    // failing path writes down who else could have written: `~/.claude.json` is shared mutable
    // state on this machine, and in r1 two of four rounds failed on one counter key with no way to
    // attribute it except by reasoning. Key *names*, process identity and mtime only — no values.
    if (summary.changedFiles.length > 0 || summary.changedKeyPaths > 0 || summary.changedDirs.length > 0)
      f.record('f13-attribution', attribution(JSON.parse(fs.readFileSync(path.join(f.raw, 'global-diff.json'), 'utf8')), redact))
    assert.deepEqual({ files: summary.changedFiles, dirs: summary.changedDirs, keyPaths: summary.changedKeyPaths },
      { files: [], dirs: [], keyPaths: 0 }, `global provider config changed: ${JSON.stringify(summary)}`)
    return { summary, before, after, reported }
  })
  const markdown = [
    '# LIFE-409 F13 — global provider config, before and after the native gate',
    '',
    `- provider: \`${path.basename(CLAUDE)}\` (\`${version}\`) — install \`${redact.text(CLAUDE)}\` → \`${redact.text(fs.realpathSync(CLAUDE))}\``,
    `- window: the \`before\` snapshot is taken immediately before the backend starts, \`after\` immediately after the pane is closed`,
    `- collector: \`app/scripts/l394/global-config-diff.mjs\` (salted value digests; no value and no key path is written out — LIFE-426)`,
    `- prompts submitted: 0 · dialogs answered: 0 · installed herdr, PATH and the user's default session untouched`,
    '',
    '## Result',
    '',
    '```json',
    JSON.stringify(summary, null, 2),
    '```',
    '',
    `- \`before\`: ${before}`,
    `- \`after\`: ${after}`,
    `- \`diff\`: ${reported.replace(/\n\s*/g, ' ')}`,
    '',
    summary.changedFiles.length === 0 && summary.changedDirs.length === 0
      ? 'No file or directory under the user\'s global provider configuration changed.'
      : 'The files and key paths listed above changed during the window. Redacted key paths only — no values and no local paths are recorded. Note that the worker session running this script is itself a `claude` process writing to the provider\'s own `.claude.json`, so changes to that file are expected to come from the session rather than from the measured pane; every other entry needs its own explanation.',
    '',
    '## Raw',
    '',
    `- \`global-before.json\`, \`global-after.json\`, \`global-diff.json\` in this directory`,
    `- run record: \`run.json\``,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(f.raw, 'global-config-diff.md'), markdown)
  console.log(markdown)
} finally { await f.cleanup() }
