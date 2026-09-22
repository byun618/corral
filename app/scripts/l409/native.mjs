// LIFE-409 gate ② — the native-execution gate (00-analysis §7.3).
//
// The pane this binds an attempt to runs the user's own natively installed claude, started in a
// throwaway git directory and never prompted. The sequence is F3 (identity) → F2 (restart) →
// F5 (the pane is closed and the attempt becomes unknown), with the global provider config
// digested before and after so F13 can say what, if anything, moved.
//
// Nothing is submitted to the provider: no --prompt, no terminal send, no answer to any dialog.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixture } from './lib.mjs'
import { differences, EXCLUDED } from './compare.mjs'

const CLAUDE = process.env.L409_NATIVE_CLAUDE ?? path.join(os.homedir(), '.local/bin/claude')
assert(fs.existsSync(CLAUDE), `The native provider is expected at ${CLAUDE}`)
const version = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).trim()

const DIFF_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../l394/global-config-diff.mjs')
const f = await fixture('native')
let runtime
/** The LIFE-394 collector, writing into this run's raw directory under its own salt. */
const diff = mode => execFileSync(process.execPath, [DIFF_SCRIPT, mode], {
  encoding: 'utf8',
  env: { ...process.env, L394_RAW: f.raw, L394_SALT_FILE: process.env.L409_SALT_FILE ?? '/tmp/l409-claude-salt' },
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
    return { providerVersion: version, providerPath: fs.realpathSync(CLAUDE), shown, dispatched }
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
    assert.equal(shown.result.terminal.reason, 'pane_gone')
    assert.equal(shown.result.dispatch.status, 'unknown')
    assert.equal(shown.result.dispatch.settledBy, 'reconcile')
    assert.equal(shown.result.task.status, 'dispatched', 'the Task is never settled by an observation')
    // The identity of the dead attempt, including its agent snapshot, is still on record.
    assert.equal(shown.result.dispatch.agent.kind, 'claude')
    const settled = await f.cli(['orchestration', 'task-update', '--id', taskId, '--status', 'failed'])
    assert.equal(settled.result.task.status, 'failed')
    assert.equal(settled.result.dispatch, null)
    return { shown, settled }
  })

  const after = diff('after')
  const reported = diff('diff')
  f.record('state-after-native', f.stateJson())
  const summary = JSON.parse(fs.readFileSync(path.join(f.raw, 'global-diff.json'), 'utf8')).summary
  const markdown = [
    '# LIFE-409 F13 — global provider config, before and after the native gate',
    '',
    `- provider: \`${CLAUDE}\` → \`${fs.realpathSync(CLAUDE)}\` (\`${version}\`)`,
    `- window: the \`before\` snapshot is taken immediately before the backend starts, \`after\` immediately after the pane is closed`,
    `- collector: \`app/scripts/l394/global-config-diff.mjs\` (salted value digests, no values are written out)`,
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
      : 'The files and key paths listed above changed during the window. Key paths only — no values are recorded. Note that the worker session running this script is itself a `claude` process writing to `~/.claude.json`, so changes to that file are expected to come from the session rather than from the measured pane; every other entry needs its own explanation.',
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
