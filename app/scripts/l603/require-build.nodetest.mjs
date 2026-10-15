// LIFE-603 R3-J 자기점검 — 빌드 산출물 칸은 평소 out/ 이 없으면 건너뛰고, 관문 모드(L603_REQUIRE_BUILD=1)에선 실패한다.
// 장치 디렉터리를 out/ 이 없는 임시 app 아래로 복사해 두 갈래를 돌린다(실제 app/out 은 건드리지 않는다).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

test('R3-J out/ 없음 — 평소 skipped 2 · fail 0, L603_REQUIRE_BUILD=1 이면 fail 2 · skipped 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l603-rb-'))
  try {
    const copy = path.join(dir, 'app', 'scripts', 'l603')
    fs.cpSync(here, copy, { recursive: true })
    // 소스 대조 칸이 읽는 파일 하나만 함께(out/ 은 복사하지 않는다)
    fs.mkdirSync(path.join(dir, 'app', 'src', 'shared'), { recursive: true })
    fs.copyFileSync(path.join(here, '..', '..', 'src', 'shared', 'terminal-paste.ts'), path.join(dir, 'app', 'src', 'shared', 'terminal-paste.ts'))
    const files = ['delay-cancel.nodetest.mjs', 'unguarded.nodetest.mjs'].map((name) => path.join(copy, name))
    const env = { ...process.env }
    delete env.L603_REQUIRE_BUILD
    delete env.NODE_TEST_CONTEXT
    const count = (out, name) => Number(new RegExp(`^ℹ ${name} (\\d+)$`, 'm').exec(out)?.[1] ?? NaN)
    const normal = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8', env, timeout: 120_000 })
    assert.equal(normal.status, 0, normal.stdout)
    assert.equal(count(normal.stdout, 'skipped'), 2)
    assert.equal(count(normal.stdout, 'fail'), 0)
    const gate = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8', env: { ...env, L603_REQUIRE_BUILD: '1' }, timeout: 120_000 })
    assert.notEqual(gate.status, 0)
    assert.equal(count(gate.stdout, 'skipped'), 0)
    assert.equal(count(gate.stdout, 'fail'), 2)
    assert.match(gate.stdout, /L603_REQUIRE_BUILD=1 인데 out\/ 이 없다/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
