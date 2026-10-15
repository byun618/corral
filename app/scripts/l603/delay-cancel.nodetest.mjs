// LIFE-603 R1-H ⑤ 자기점검 — 대체 CLI(가짜)로 분류 · 실패 전파를 본다. 실제 런타임 실측은 최종 관문 몫.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classify } from './delay-cancel.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SOCK = '/tmp/l603g-selfcheck/ud/runtime/rpc.sock'

test('classify — 취소·미확정은 주입됨, 끝남은 too_slow, 다른 거절은 not_started', () => {
  assert.equal(classify({ ok: false, error: { code: 'request_cancelled' } }), 'injected')
  assert.equal(classify({ ok: false, error: { code: 'outcome_unknown' } }), 'injected')
  assert.equal(classify({ ok: false, error: { code: 'operation_failed' }, _meta: { outcome: 'unknown' } }), 'injected')
  assert.equal(classify({ ok: true, result: {} }), 'too_slow')
  assert.equal(classify({ ok: false, error: { code: 'invalid_request' }, _meta: { outcome: 'not_started' } }), 'not_started')
  assert.equal(classify(null), 'no_response')
})

test('가짜 CLI 로 끝까지 — 주입 성공 exit 0 · 너무 느린 주입 exit 3 · 매달린 자식 exit 4 · 소켓 가드 exit 2', () => {
  const dir = fs.mkdtempSync('/tmp/l603w-dc-')
  try {
    // 기한(--timeout-ms)이 150 보다 짧으면 취소, 길면 완료를 흉내 낸다.
    const fake = path.join(dir, 'fake.mjs')
    fs.writeFileSync(fake, `const a = process.argv; const t = Number(a[a.indexOf('--timeout-ms') + 1]); const mode = process.env.FAKE_MODE;
if (mode === 'hang') setInterval(() => {}, 1000);
else console.log(JSON.stringify(t < 150 && mode !== 'fast' ? { ok: false, error: { code: 'request_cancelled' }, _meta: { outcome: 'unknown' } } : { ok: true, result: { replayed: true } }))`)
    const run = (env, extra = []) => spawnSync(process.execPath, [path.join(here, 'delay-cancel.mjs'), '--socket', SOCK, '--repo', '/r', '--name', 'n', '--cli', fake, '--short-ms', '100', '--long-ms', '200', ...extra], { encoding: 'utf8', env: { ...process.env, ...env } })
    const ok = run({ FAKE_MODE: '' })
    assert.equal(ok.status, 0, ok.stdout)
    assert.deepEqual(JSON.parse(ok.stdout).second.response, { ok: true, result: { replayed: true } })
    assert.equal(run({ FAKE_MODE: 'fast' }).status, 3)
    const hung = spawnSync(process.execPath, [path.join(here, 'delay-cancel.mjs'), '--socket', SOCK, '--repo', '/r', '--name', 'n', '--cli', fake, '--short-ms', '100', '--long-ms', '1'], { encoding: 'utf8', env: { ...process.env, FAKE_MODE: 'hang' }, timeout: 60_000 })
    assert.equal(hung.status, 4)
    assert.equal(spawnSync(process.execPath, [path.join(here, 'delay-cancel.mjs'), '--socket', `${process.env.HOME}/Library/Application Support/corral/runtime/rpc.sock`, '--repo', '/r', '--name', 'n'], { encoding: 'utf8' }).status, 2)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
