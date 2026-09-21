// LIFE-394 F13: the LIFE-393 terminal contract, re-run against the new backend and the new CLI.
//
// `scripts/l393/contract.mjs` asserts the terminal surface is exactly nine commands, which LIFE-394
// changes by adding `terminal prompt`. That script belongs to the previous round and is not this
// design's to edit (§6), so the same four checks run here with the command set updated: the nine
// LIFE-393 commands must still be present, behave identically, and answer `--help`.
import assert from 'node:assert/strict'
import { fixture, pause, until } from './lib.mjs'

const L393_COMMANDS = ['terminal create', 'terminal list', 'terminal show', 'terminal read',
  'terminal send', 'terminal wait', 'terminal switch', 'terminal rename', 'terminal close']

const f = await fixture('l393')
try {
  await f.startBackend()
  await f.serve()
  await f.cli(['repo', 'add', '--path', f.repo])
  const a = await f.receiver('a'), handle = a.terminal.handle

  await f.check('Q1-help-schema-limits-errors', async () => {
    const schema = JSON.parse((await f.run(process.execPath, [new URL('../../cli/corral.mjs', import.meta.url).pathname, 'agent-context', '--json'])).stdout)
    const terminal = schema.commands.filter(spec => spec.command.startsWith('terminal '))
    const names = terminal.map(spec => spec.command)
    for (const command of L393_COMMANDS) assert(names.includes(command), `LIFE-393 command missing: ${command}`)
    assert.deepEqual(names.filter(name => !L393_COMMANDS.includes(name)), ['terminal prompt'])
    const helps = []
    for (const spec of terminal) { const result = await f.cli([...spec.path, '--help']); assert.equal(result.commands[0].command, spec.command); helps.push(spec.command) }
    await f.cli(['terminal', 'list', '--limit', '10000'])
    await f.cli(['terminal', 'read', '--terminal', handle, '--limit', '262144'])
    const failed = []
    for (const args of [['terminal', 'list', '--limit', '10001'],
      ['terminal', 'read', '--terminal', handle, '--limit', '262145'],
      ['terminal', 'read', '--terminal', handle, '--limit', '1.2'],
      ['terminal', 'rename', '--terminal', handle, '--title', 'x'.repeat(1025)],
      ['terminal', 'create', '--worktree', f.repo, '--command', 'x'.repeat(65537)],
      ['terminal', 'send', '--terminal', 'same-title', '--text', 'NO'],
      ['terminal', 'close', '--terminal', String(process.pid)],
      ['terminal', 'split', '--terminal', handle]]) failed.push((await f.cli(args, { fail: true })).error.code)
    const title = 'x'.repeat(1024)
    await f.cli(['terminal', 'rename', '--terminal', handle, '--title', title])
    assert.equal((await f.cli(['terminal', 'show', '--terminal', handle])).result.terminal.title, title)
    const command = 'printf LIMIT_OK; #' + 'x'.repeat(65536 - 'printf LIMIT_OK; #'.length)
    const created = await f.cli(['terminal', 'create', '--worktree', f.repo, '--command', command])
    assert.equal(created.result.stage, 'command_accepted')
    await f.cli(['terminal', 'close', '--terminal', created.result.terminal.handle])
    // Nothing above typed anything into the receiver pane.
    assert.equal(a.input().length, 0)
    return { commands: names, helps, failed, commandLimitStage: created.result.stage }
  })

  await f.check('F2-ambiguous-worktree-no-effect', async () => {
    for (const worktree of [f.repo, f.linked]) await f.cli(['worktree', 'set', '--worktree', worktree, '--display-name', 'collision'])
    const before = (await f.cli(['terminal', 'list'])).result.totalCount
    const result = await f.cli(['terminal', 'create', '--worktree', 'name:collision'], { fail: true })
    assert.equal(result.error.code, 'ambiguous_target')
    assert.equal(result._meta.outcome, 'not_started')
    assert.equal((await f.cli(['terminal', 'list'])).result.totalCount, before)
    return result.error
  })

  await f.check('F6-no-cursor-requires-new-observation', async () => {
    a.output('OLD_ONLY'); await pause(100)
    const stale = await f.cli(['terminal', 'wait', '--terminal', handle, '--for', 'output', '--text', 'OLD_ONLY', '--timeout-ms', '300'], { fail: true })
    assert.equal(stale.error.code, 'wait_timeout')
    const pending = f.cli(['terminal', 'wait', '--terminal', handle, '--for', 'output', '--text', 'FRESH', '--timeout-ms', '3000'])
    await pause(300); a.output('FRESH')
    const fresh = await pending
    assert.equal(fresh.result.condition, 'output')
    return { stale: stale.error.code, fresh: fresh.result.condition }
  })

  await f.check('F7-close-OS-process-oracle', async () => {
    const before = (await f.cli(['terminal', 'show', '--terminal', handle])).result.process
    const pids = [before.shellPid, ...before.foreground.map(entry => entry.pid)]
    const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
    assert(pids.every(alive))
    const closed = await f.cli(['terminal', 'close', '--terminal', handle])
    await until(() => pids.every(pid => !alive(pid)), 'closed shell and foreground process exit')
    return { pids, closed: closed.result.stage, aliveAfter: pids.map(alive) }
  })
} finally { await f.cleanup() }
