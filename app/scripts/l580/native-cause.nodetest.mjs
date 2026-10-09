// native-cause 종료 정리 시험 (LIFE-580 R3-A4) — 가짜 herdr CLI(받은 인자를 파일에 적는 셸 스크립트)로 실제 스크립트 프로세스를 돌린다.
// 정상 끝 · SIGINT · SIGTERM · 일반 예외 모두 `--release` 면 **같은 pane·source·agent** 로 release 를 **한 번** 부르고,
// 중단·예외는 실패(exit 1)와 줄로 남는지, release 실패도 남는지, `--release` 없으면 부르지 않는지 본다. 원인 줄의 대상·기대 상태(R3-A2)도 본다.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'native-cause.mjs')
const PANE = 'w9:p7'

const made = []
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l580-cause-'))
  made.push(dir)
  const bin = path.join(dir, 'herdr')
  fs.writeFileSync(bin, '#!/bin/sh\necho "$*" >> "$FAKE_LOG"\nif [ "$2" = release-agent ]; then exit "${FAKE_RELEASE_EXIT:-0}"; fi\nexit 0\n', { mode: 0o755 })
  return { dir, bin, log: path.join(dir, 'calls.txt'), out: path.join(dir, 'cause.ndjson') }
}

/** 스크립트를 띄운다. `signalAfterFirst` 면 첫 원인 줄이 stdout 에 나온 뒤 그 신호(들)를 보낸다. */
function run({ env, args, signalAfterFirst = [] }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let sent = false
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (!sent && signalAfterFirst.length > 0 && /^0 \w+ pane=/m.test(stdout)) {
        sent = true
        for (const signal of signalAfterFirst) child.kill(signal)
      }
    })
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
const rows = (file) => read(file).split('\n').filter(Boolean).map((line) => JSON.parse(line))
const calls = (file) => read(file).split('\n').filter(Boolean)
const RELEASE = `pane release-agent ${PANE} --source l580-native-j5 --agent claude`

function base(t, extra = {}) {
  return { HERDR_BIN_PATH: t.bin, HERDR_SOCKET_PATH: path.join(t.dir, 'herdr.sock'), HERDR_PANE_ID: PANE, FAKE_LOG: t.log, ...extra }
}

describe('native-cause --release 종료 정리 (R3-A4)', () => {
  it('정상 끝 — 보고 둘, 같은 pane·source·agent release 한 번, 원인 줄에 대상·기대 상태', async () => {
    const t = setup()
    const started = Date.now()
    const result = await run({ env: base(t), args: ['--out', t.out, '--sequence', 'working,idle', '--gap-ms', '1000', '--release'] })
    assert.equal(result.code, 0)
    // 마지막 보고 뒤 한 간격을 기다린 뒤 release — 전이 사이 1초 + 마지막 뒤 1초(r3 dry-run d02 결함)
    assert.ok(Date.now() - started >= 2_000)
    const got = calls(t.log)
    assert.equal(got.filter((line) => line.includes('report-agent')).length, 2)
    assert.deepEqual(got.filter((line) => line.includes('release-agent')), [RELEASE])
    const written = rows(t.out)
    assert.deepEqual(written.filter((row) => row.kind === 'cause').map((row) => [row.target, row.expect, row.expectDots]), [[PANE, 'working', ['working']], [PANE, 'idle', ['idle', 'done']]])
    assert.deepEqual(written.filter((row) => row.kind === 'release').map((row) => [row.reason, row.exit]), [['end', 0]])
  })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    it(`${signal} — 다음 전이를 기다리는 중 중단: 실패(exit 1) · 중단 줄 · release 한 번`, async () => {
      const t = setup()
      const result = await run({ env: base(t), args: ['--out', t.out, '--sequence', 'working,idle,blocked', '--gap-ms', '8000', '--release'], signalAfterFirst: [signal] })
      assert.equal(result.code, 1)
      const got = calls(t.log)
      assert.equal(got.filter((line) => line.includes('report-agent')).length, 1)
      assert.deepEqual(got.filter((line) => line.includes('release-agent')), [RELEASE])
      const written = rows(t.out)
      assert.deepEqual(written.filter((row) => row.kind === 'interrupted').map((row) => row.signal), [signal])
      assert.deepEqual(written.filter((row) => row.kind === 'release').map((row) => [row.reason, row.exit]), [[signal, 0]])
    })
  }

  it('신호 두 번(SIGINT 뒤 SIGTERM) — release 는 여전히 한 번', async () => {
    const t = setup()
    const result = await run({ env: base(t), args: ['--out', t.out, '--sequence', 'working,idle', '--gap-ms', '8000', '--release'], signalAfterFirst: ['SIGINT', 'SIGTERM'] })
    assert.equal(result.code, 1)
    assert.equal(calls(t.log).filter((line) => line.includes('release-agent')).length, 1)
  })

  it('release 실패도 남는다 — 중단 + release exit 1 → 줄에 exit 1, 프로세스 exit 1', async () => {
    const t = setup()
    const result = await run({ env: base(t, { FAKE_RELEASE_EXIT: '3' }), args: ['--out', t.out, '--sequence', 'working,idle', '--gap-ms', '8000', '--release'], signalAfterFirst: ['SIGINT'] })
    assert.equal(result.code, 1)
    assert.deepEqual(rows(t.out).filter((row) => row.kind === 'release').map((row) => [row.reason, row.exit]), [['SIGINT', 3]])
    // 정상 끝에서 release 만 실패해도 exit 1
    const t2 = setup()
    const end = await run({ env: base(t2, { FAKE_RELEASE_EXIT: '3' }), args: ['--out', t2.out, '--state', 'working', '--release'] })
    assert.equal(end.code, 1)
    assert.deepEqual(rows(t2.out).filter((row) => row.kind === 'release').map((row) => [row.reason, row.exit]), [['end', 3]])
  })

  it('일반 예외(원인 줄 쓰기 실패) — 보고 뒤 예외여도 release 한 번 · exit 1 · 기록 실패를 stderr 에 남긴다', async () => {
    const t = setup()
    const outDir = path.join(t.dir, 'is-a-dir')
    fs.mkdirSync(outDir)
    const result = await run({ env: base(t), args: ['--out', outDir, '--sequence', 'working,idle', '--gap-ms', '1000', '--release'] })
    assert.equal(result.code, 1)
    const got = calls(t.log)
    assert.equal(got.filter((line) => line.includes('report-agent')).length, 1)
    assert.deepEqual(got.filter((line) => line.includes('release-agent')), [RELEASE])
    assert.match(result.stderr, /예외 — 실패 회차/)
    assert.match(result.stderr, /기록 실패\(release\)/)
  })

  it('--release 없으면 중단돼도 release 를 부르지 않는다(중단 줄·exit 1 은 남는다)', async () => {
    const t = setup()
    const result = await run({ env: base(t), args: ['--out', t.out, '--sequence', 'working,idle', '--gap-ms', '8000'], signalAfterFirst: ['SIGINT'] })
    assert.equal(result.code, 1)
    assert.equal(calls(t.log).filter((line) => line.includes('release-agent')).length, 0)
    assert.deepEqual(rows(t.out).map((row) => row.kind), ['cause', 'interrupted'])
  })

  it('unknown 은 J5 전이가 아니다 — 사용법 오류(exit 2), 아무것도 부르지 않는다', async () => {
    const t = setup()
    const result = await run({ env: base(t), args: ['--out', t.out, '--state', 'unknown', '--release'] })
    assert.equal(result.code, 2)
    assert.equal(calls(t.log).length, 0)
  })
})
