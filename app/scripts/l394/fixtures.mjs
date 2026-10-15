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
  await f.startBackend('stock', { guard: false })
  await f.serve()
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
  await f.serve()
  await f.cli(['repo', 'add', '--path', f.repo])
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
  await f.serve()
  await f.cli(['repo', 'add', '--path', f.repo])
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
    for (const [agent, version] of [['claude', '2026.09.04.1'], ['codex', '2026.10.15.1'], ['grok', '2026.10.15.1']]) {
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
    await f.cli(['terminal', 'close', '--terminal', handle])
    const stale = await f.cli(['terminal', 'prompt', '--terminal', handle, '--text', 'gone', '--request-id', requestId()], { fail: true })
    assert.equal(stale.error.code, 'stale_terminal', JSON.stringify(stale))
    return stale.error
  })
})

// --- F12/F14: static checks on the source itself ------------------------------------------------
// Scoped to what LIFE-394 changed. The GUI row-creation path (`adapter/internal/lifecycle.ts`, and
// the `agent.start` entry ALLOWED_METHODS already carried for it) predates this work and §6 lists it
// under "do not touch" — the check below proves it is byte-identical to the design commit rather
// than pretending it does not exist.
const repoRoot = path.join(app, '..')
const git = (...rest) => execFileSync('git', ['-C', repoRoot, ...rest], { encoding: 'utf8' })
const changed = git('diff', '--name-only', '53e748b..HEAD', '--', 'app/src').split('\n').filter(Boolean)
const files = changed.filter(name => name.endsWith('.ts')).map(name => path.join(repoRoot, name))
const GUI_AGENT_PATH = ['app/src/main/adapter/internal/lifecycle.ts', 'app/src/main/adapter/internal/request.ts']
const staticChecks = []
function staticCheck(id, fn) {
  try { staticChecks.push({ id, pass: true, detail: fn() }) } catch (error) { staticChecks.push({ id, pass: false, error: String(error) }) }
}
staticCheck('F12-no-agent-call-outside-the-guard', () => {
  // In everything LIFE-394 changed, agent.* is named in exactly one place: the adapter method that
  // wraps it in a corral.terminal envelope. Nothing else reaches herdr's app dispatch table.
  const offenders = files.filter(file => /['"]agent\.(start|get|prompt)['"]/.test(fs.readFileSync(file, 'utf8')))
    .filter(file => !file.endsWith('src/main/adapter/internal/terminal-backend.ts'))
    .map(file => path.relative(repoRoot, file))
  assert.deepEqual(offenders, [])
  return { scanned: files.length, changed }
})
staticCheck('F12-untouched-files-are-byte-identical', () => {
  // §6: ALLOWED_METHODS, the receipt store and the GUI launch path are not this design's to change.
  const frozen = [...GUI_AGENT_PATH, 'app/src/runtime/terminal/receipts.ts', 'app/src/main/lifecycle.ts']
    .filter(name => fs.existsSync(path.join(repoRoot, name)))
  const diff = git('diff', '53e748b..HEAD', '--', ...frozen)
  assert.equal(diff.trim(), '', diff)
  return { unchanged: frozen }
})
// G9: `as T` and `as const` are different things and are now reported as two numbers, not one
// sentence. The old pattern anchored the type name on [A-Z], so every lowercase primitive — the
// `as string`, `as number`, `as boolean` a reviewer would most expect it to catch — walked past it.
// R14: and a type that *starts with a parenthesis* — `as ((x: A) => B) | null`, the function type
// this round's own test helper used — walked past both anchors. A type assertion is the word `as`
// followed by a type, and a type may begin with `(`; the reported `typeAssertions: 0` was a false
// negative, not a clean file. The pattern is checked against samples on every run, because a silent
// checker and a clean file look identical (memory: an empty result is evidence only after a
// positive control) — and this round is what that memory was written for.
const TYPE_NAMES = ['string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'undefined', 'null', 'never', 'unknown', 'any', 'void']
const TYPE_ASSERTION = new RegExp(String.raw`\bas\s+(?:readonly\s+)?(?:\(|[A-Z][A-Za-z0-9_]*|(?:${TYPE_NAMES.join('|')})\b)`)
const CONST_ASSERTION = /\bas\s+const\b/
// Line comments and the body of a block comment are prose: "reports the trust screen as Idle" is
// English, not a cast, and it is the false positive this strip exists for.
const codeOf = line => line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/^\s*\/\*.*$/, '')
staticCheck('F14-assertion-pattern-self-check', () => {
  const caught = ['const a = x as string', 'const b = x as number', 'const c = y as AgentRecord',
    'const d = z as unknown', 'const e = w as readonly string[]', 'const f = v as any',
    // R14 의 실제 표본: 괄호로 시작하는 함수 타입, 그리고 괄호로 시작하는 readonly 타입.
    'observe: null as ((current: AgentObservation) => AgentObservation) | null',
    'const g = h as readonly (string | number)[]']
  const missed = caught.filter(sample => !TYPE_ASSERTION.test(codeOf(sample)))
  assert.deepEqual(missed, [], 'the pattern must catch every sample assertion')
  // …and must not fire on the things that are not type assertions.
  assert.equal(TYPE_ASSERTION.test(codeOf('const kinds = [1, 2] as const')), false)
  assert.equal(TYPE_ASSERTION.test(codeOf('  // reports the real trust screen as Idle')), false)
  assert.equal(TYPE_ASSERTION.test(codeOf('  // same as (the r1 run) above')), false)
  assert.equal(CONST_ASSERTION.test(codeOf('const kinds = [1, 2] as const')), true)
  return { samples: caught.length }
})
staticCheck('F14-no-type-assertions', () => {
  const offenders = [], constAssertions = []
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      const code = codeOf(line), at = `${path.relative(repoRoot, file)}:${index + 1}`
      if (TYPE_ASSERTION.test(code)) offenders.push(at)
      if (CONST_ASSERTION.test(code)) constAssertions.push(at)
    })
  }
  assert.deepEqual(offenders, [])
  return { scanned: files.length, typeAssertions: offenders.length, constAssertions: constAssertions.length, constAssertionSites: constAssertions,
    note: '`as const` is a const assertion, not a type assertion; it is counted and listed, never asserted to be zero' }
})
staticCheck('F14-one-new-abstraction', () => {
  const added = git('diff', '--name-status', '--diff-filter=A', '53e748b', '--', 'app/src')
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
