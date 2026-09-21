// LIFE-394 F12/F14 backend fixtures. Three backend builds, each in its own isolated fixture, plus
// the checks that need a live guard but no provider launch (no model submission happens here).
//
//   CORRAL_TEST_BACKEND       the new guard build (agent_ops)
//   CORRAL_TEST_BACKEND_L393  a guard build without agent_ops
//   CORRAL_TEST_BACKEND_STOCK unpatched herdr 0.9.0
//
// Exits non-zero if any check fails (C4).
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fixture, app, requestId } from './lib.mjs'

const binaries = {
  impl: process.env.CORRAL_TEST_BACKEND,
  l393: process.env.CORRAL_TEST_BACKEND_L393,
  stock: process.env.CORRAL_TEST_BACKEND_STOCK,
}
for (const [name, binary] of Object.entries(binaries)) assert(binary && fs.existsSync(binary), `Set CORRAL_TEST_BACKEND${name === 'impl' ? '' : '_' + name.toUpperCase()}`)

const summary = []
async function withBackend(label, binary, body) {
  const f = await fixture(label, { backend: binary })
  try { await body(f) } finally { await f.cleanup(); summary.push({ label, raw: f.raw, checks: f.checks.map(({ id, pass }) => ({ id, pass })) }) }
  return f
}

// --- F12: the same commands against three backends (review 미확인 8) -----------------------------
await withBackend('f12-stock', binaries.stock, async f => {
  await f.startBackend('stock')
  await f.check('F12-stock-terminal', async () => {
    const result = await f.cli(['terminal', 'list'], { fail: true })
    assert.equal(result.error.code, 'unsupported_backend', JSON.stringify(result))
    return result.error
  })
  await f.check('F12-stock-agent', async () => {
    const result = await f.cli(['terminal', 'create', '--worktree', f.repo, '--agent', 'claude'], { fail: true })
    assert.equal(result.error.code, 'unsupported_backend', JSON.stringify(result))
    return result.error
  })
})

await withBackend('f12-l393', binaries.l393, async f => {
  await f.startBackend('l393')
  await f.check('F12-l393-handshake-has-no-agent-ops', async () => {
    const handshake = await f.backendRpc('corral.terminal')
    assert.equal(handshake.guard_version, 1)
    assert.equal(handshake.agent_ops, undefined, JSON.stringify(handshake))
    return handshake
  })
  await f.check('F12-l393-terminal-works', async () => {
    const created = await f.cli(['terminal', 'create', '--worktree', f.repo, '--title', 'plain'])
    assert.equal(created.result.stage, 'pty_created')
    return { handle: created.result.terminal.handle, stage: created.result.stage }
  })
  await f.check('F12-l393-agent-refused-without-effect', async () => {
    const before = (await f.cli(['terminal', 'list'])).result.totalCount
    const refused = await f.cli(['terminal', 'create', '--worktree', f.repo, '--agent', 'claude'], { fail: true })
    assert.equal(refused.error.code, 'unsupported_backend', JSON.stringify(refused))
    // The preflight runs before backend.create, so a refused agent create leaves no half-made pane.
    const after = (await f.cli(['terminal', 'list'])).result.totalCount
    assert.equal(after, before, `pane count moved ${before} -> ${after}`)
    return { before, after, error: refused.error }
  })
})

await withBackend('f12-impl', binaries.impl, async f => {
  await f.startBackend('impl')
  await f.check('F12-impl-handshake-advertises-agent-ops', async () => {
    const handshake = await f.backendRpc('corral.terminal')
    assert.equal(handshake.agent_ops, 1, JSON.stringify(handshake))
    return handshake
  })
  // C5: the manifest versions corral gates on, observed through the guard on the build under test.
  await f.check('C5-guard-agent-manifests', async () => {
    const response = await f.backendRpc('corral.terminal', { epoch: (await f.backendRpc('corral.terminal')).epoch,
      deadline_ms: Date.now() + 15000, operation: { method: 'server.agent_manifests', params: {} } })
    const manifests = Object.fromEntries((response.manifests ?? []).map(row => [row.agent, row]))
    for (const [agent, version] of [['claude', '2026.09.04.1'], ['codex', '2026.09.21.3'], ['grok', '2026.09.21.3']]) {
      assert.equal(manifests[agent]?.active_version, version, JSON.stringify(manifests[agent]))
      assert.equal(manifests[agent]?.source_kind, 'bundled', JSON.stringify(manifests[agent]))
      assert.equal(manifests[agent]?.local_override_shadowing_remote, false, JSON.stringify(manifests[agent]))
    }
    fs.writeFileSync(path.join(f.raw, 'guard-agent-manifests.json'), JSON.stringify(response, null, 2) + '\n')
    return manifests
  })
  const created = await f.cli(['terminal', 'create', '--worktree', f.repo, '--title', 'shell-only'])
  const handle = created.result.terminal.handle
  await f.check('F8c-prompt-without-an-agent', async () => {
    // A pane that never had a managed agent refuses the submission with no effect and no record.
    const refused = await f.cli(['terminal', 'prompt', '--terminal', handle, '--text', 'never delivered', '--request-id', requestId()], { fail: true })
    assert.equal(refused.error.code, 'agent_not_found', JSON.stringify(refused))
    return refused.error
  })
  await f.check('F6-agent-ready-times-out-on-a-shell-pane', async () => {
    const timed = await f.cli(['terminal', 'wait', '--terminal', handle, '--for', 'agent-ready', '--timeout-ms', '4000'], { fail: true, timeout: 30000 })
    assert.equal(timed.error.code, 'wait_timeout', JSON.stringify(timed))
    return timed.error
  })
  await f.check('F12-stale-terminal-after-close', async () => {
    await f.cli(['terminal', 'close', '--terminal', handle, '--request-id', requestId()])
    const stale = await f.cli(['terminal', 'prompt', '--terminal', handle, '--text', 'gone', '--request-id', requestId()], { fail: true })
    assert.equal(stale.error.code, 'stale_terminal', JSON.stringify(stale))
    return stale.error
  })
})

// --- F12/F14: static checks on the source itself ------------------------------------------------
const sources = ['src/runtime', 'src/main', 'src/shared', 'src/preload'].map(dir => path.join(app, dir))
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])
const files = sources.flatMap(walk).filter(file => file.endsWith('.ts'))
const staticChecks = []
function staticCheck(id, fn) {
  try { staticChecks.push({ id, pass: true, detail: fn() }) } catch (error) { staticChecks.push({ id, pass: false, error: String(error) }) }
}
staticCheck('F12-no-agent-call-outside-the-guard', () => {
  // Every agent.* call must travel inside a corral.terminal envelope, which only the adapter builds.
  const offenders = files.filter(file => /['"]agent\.(start|get|prompt)['"]/.test(fs.readFileSync(file, 'utf8')))
    .filter(file => !file.endsWith('src/main/adapter/internal/terminal-backend.ts'))
  assert.deepEqual(offenders, [])
  return { scanned: files.length }
})
staticCheck('F12-allowed-methods-unchanged', () => {
  const diff = execFileSync('git', ['-C', path.join(app, '..'), 'diff', 'da7498c~2', '--', 'app/src/main/adapter/internal/request.ts', 'app/src/runtime/terminal/receipts.ts', 'app/src/main/lifecycle.ts'], { encoding: 'utf8' })
  assert.equal(diff.trim(), '', diff)
  return { unchanged: ['request.ts (ALLOWED_METHODS)', 'receipts.ts', 'lifecycle.ts'] }
})
staticCheck('F14-no-type-assertions', () => {
  const pattern = /\bas\s+(?!const\b)[A-Z][A-Za-z0-9_]*|\bas\s+(?:readonly|unknown|any)\b/
  const offenders = []
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (pattern.test(code)) offenders.push(`${path.relative(app, file)}:${index + 1}`)
    })
  }
  assert.deepEqual(offenders, [])
  return { scanned: files.length }
})
staticCheck('F14-one-new-abstraction', () => {
  const added = execFileSync('git', ['-C', path.join(app, '..'), 'diff', '--name-status', '--diff-filter=A', '53e748b', '--', 'app/src'], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map(line => line.split('\t')[1])
  assert.deepEqual(added, ['app/src/runtime/terminal/agent.ts'])
  return { added }
})

const failedStatic = staticChecks.filter(check => !check.pass)
const out = path.resolve(process.env.CORRAL_VERIFY_RAW ?? path.join(app, '../specs/LIFE-394-cli-agents/raw/worker/claude/impl'))
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'fixtures.json'), JSON.stringify({ at: new Date().toISOString(), binaries, summary, staticChecks }, null, 2) + '\n')
console.log(JSON.stringify({ staticChecks: staticChecks.map(({ id, pass }) => ({ id, pass })), failedStatic: failedStatic.length }))
if (failedStatic.length) process.exitCode = 1
