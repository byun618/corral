// repro 스크립트(`scripts/l577/repro.mjs`)를 실제 서버에 돌린다 (LIFE-577 A9) — 스크립트가 거절 행렬을 맞게 판정하고,
// 출력에 토큰·코드 원문이 없고, 종료 코드로 성패를 내는지.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { PairingStore, PAIRING_TTL_MS } from './pairing.js'
import { MobileServer } from './server.js'

const run = promisify(execFile)
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const REPRO = path.join(APP, 'scripts/l577/repro.mjs')

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Outcome = { code: number; rows: Record<string, unknown>[]; stdout: string }

async function repro(args: string[]): Promise<Outcome> {
  try {
    const { stdout } = await run(process.execPath, [REPRO, ...args], { cwd: APP, timeout: 60_000 })
    return { code: 0, rows: parse(stdout), stdout }
  } catch (error) {
    const failure = error instanceof Error && 'stdout' in error && 'code' in error ? error : null
    const stdout = failure !== null && typeof failure.stdout === 'string' ? failure.stdout : ''
    return { code: failure !== null && typeof failure.code === 'number' ? failure.code : -1, rows: parse(stdout), stdout }
  }
}

function parse(stdout: string): Record<string, unknown>[] {
  return stdout.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line))
}

async function setup(timing: { livenessIntervalMs?: number; idleTimeoutMs?: number } = {}): Promise<{ url: string; store: PairingStore; server: MobileServer; dir: string; advance: (ms: number) => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l577x-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  let now = Date.now()
  const store = new PairingStore({ dir: path.join(dir, 'mobile'), now: () => now })
  store.load()
  const server = new MobileServer({ pairing: store, appVersion: '0.1.2-test', macName: () => 'test-mac', log: () => {}, onChange: () => {}, authTimeoutMs: 300, ...timing })
  const port = await server.start()
  cleanups.push(() => server.stop())
  return { url: `ws://127.0.0.1:${port}/ws`, store, server, dir, advance: (ms) => { now += ms } }
}

describe('repro 스크립트 (A9)', () => {
  it('pair → hello → ping 통과(exit 0), 토큰 파일 0600, 출력에 코드·토큰 원문 없음', async () => {
    const { url, store, dir } = await setup()
    const { code } = store.createCode()
    const tokenFile = path.join(dir, 'token')
    const out = await repro(['pair', '--url', url, '--code', code, '--name', 'repro', '--token-out', tokenFile])
    expect(out.code).toBe(0)
    expect(out.rows.map((row) => row.step)).toEqual(['pair', 'after-pair:hello', 'after-pair:ping', undefined])
    const token = fs.readFileSync(tokenFile, 'utf8').trim()
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600)
    expect(out.stdout).not.toContain(code)
    expect(out.stdout).not.toContain(token)
    expect(out.stdout).toContain('<redacted>')
    const hello = await repro(['hello', '--url', url, '--token-file', tokenFile])
    expect(hello.code).toBe(0)
    expect(hello.stdout).not.toContain(token)
  })

  it('거절 행렬 전부 + 양성 대조 — 모든 줄 통과(exit 0)', async () => {
    const { url, store, dir, advance } = await setup()
    // 양성 대조용 기기
    const good = store.createCode()
    const tokenFile = path.join(dir, 'good')
    expect((await repro(['pair', '--url', url, '--code', good.code, '--token-out', tokenFile])).code).toBe(0)
    // 해지할 기기
    const doomed = store.createCode()
    const doomedFile = path.join(dir, 'doomed')
    expect((await repro(['pair', '--url', url, '--code', doomed.code, '--token-out', doomedFile])).code).toBe(0)
    const doomedId = store.list().find((device) => device.id !== store.authenticate(fs.readFileSync(tokenFile, 'utf8').trim())?.id)?.id
    if (doomedId === undefined) throw new Error('기기 없음')
    store.revoke(doomedId)
    // 만료 코드. 틀린 pair 시도는 **그때 유효한 코드**의 실패 횟수로 센다 — 그래서 사용·만료 코드 줄과 「5회 틀린 뒤 정답」 은 실행을 나눈다.
    const expired = store.createCode()
    advance(PAIRING_TTL_MS + 1)
    const first = await repro([
      'matrix', '--url', url, '--token-file', tokenFile, '--revoked-token-file', doomedFile,
      '--used-code', good.code, '--expired-code', expired.code, '--auth-timeout',
    ])
    const fresh = store.createCode()
    const second = await repro(['matrix', '--url', url, '--token-file', tokenFile, '--fresh-code', fresh.code])
    for (const out of [first, second]) {
      expect(out.rows.filter((row) => row.pass === false)).toEqual([])
      expect(out.code).toBe(0)
    }
    const steps = [...first.rows, ...second.rows].map((row) => row.step).filter((step) => typeof step === 'string')
    expect(steps).toEqual(expect.arrayContaining([
      'http:GET /', 'http:GET /ws', 'http:POST /ws', 'ws:no-token', 'ws:wrong-token', 'ws:ping-before-auth', 'ws:bad-json',
      'ws:protocol-mismatch', 'ws:too-large', 'ws:revoked-token', 'ws:used-code', 'ws:expired-code',
      'ws:unknown-code', 'ws:wrong-code-5', 'ws:right-code-after-5-wrong', 'ws:auth-timeout', 'positive:hello', 'positive:ping',
    ]))
    const stdout = first.stdout + second.stdout
    // R5 A4ⓖ — 세 실패 코드가 각자의 줄에서 기대값으로 판별됐다. A5ⓓ — hello 줄에 맥 이름이 찍힌다.
    const expectOf = (step: string): unknown => [...first.rows, ...second.rows].find((row) => row.step === step)?.expect
    expect(expectOf('ws:used-code')).toMatchObject({ error: 'code_used' })
    expect(expectOf('ws:expired-code')).toMatchObject({ error: 'code_expired' })
    expect(expectOf('ws:unknown-code')).toMatchObject({ error: 'code_invalid' })
    expect(expectOf('ws:right-code-after-5-wrong')).toMatchObject({ error: 'code_invalid' })
    expect(stdout).toContain('"macName":"test-mac"')
    for (const secret of [good.code, expired.code, fresh.code, fs.readFileSync(tokenFile, 'utf8').trim(), fs.readFileSync(doomedFile, 'utf8').trim()]) {
      expect(stdout).not.toContain(secret)
    }
  }, 60_000)

  // R2-A4 — `--token-out` 은 새 파일만 0600 으로 원자 생성. 이미 있는 파일(0644)·심링크는 pair 전에 거절(exit 2) — 코드를 소모하지 않는다.
  it.each([
    ['이미 있는 0644 파일', (file: string) => { fs.writeFileSync(file, 'old\n'); fs.chmodSync(file, 0o644) }],
    ['심링크', (file: string) => { const target = `${file}-target`; fs.writeFileSync(target, ''); fs.symlinkSync(target, file) }],
    ['대상 없는 심링크', (file: string) => fs.symlinkSync(`${file}-missing`, file)],
  ])('--token-out 이 %s 이면 exit 2 · 코드 그대로 · 파일에 토큰 없음 (R2-A4)', async (_name, prepare) => {
    const { url, store, dir } = await setup()
    const { code } = store.createCode()
    const tokenFile = path.join(dir, 'token')
    prepare(tokenFile)
    const out = await repro(['pair', '--url', url, '--code', code, '--token-out', tokenFile])
    expect(out.code).toBe(2)
    expect(store.list()).toHaveLength(0)
    expect(store.pairingExpiresAt()).not.toBeNull()
    for (const file of [tokenFile, `${tokenFile}-target`]) {
      if (fs.existsSync(file)) expect(fs.readFileSync(file, 'utf8')).not.toMatch(/^[A-Za-z0-9_-]{40,}$/m)
    }
  })

  it('--token-out 새 파일은 umask 000 에서도 0600 (R2-A4)', async () => {
    const { url, store, dir } = await setup()
    const { code } = store.createCode()
    const tokenFile = path.join(dir, 'fresh-token')
    const previous = process.umask(0)
    let out: Outcome
    try {
      out = await repro(['pair', '--url', url, '--code', code, '--token-out', tokenFile])
    } finally {
      process.umask(previous)
    }
    expect(out.code).toBe(0)
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600)
  })

  it('양성 대조가 실패하면 exit 1 — 틀린 토큰 파일', async () => {
    const { url, dir } = await setup()
    const bad = path.join(dir, 'bad')
    fs.writeFileSync(bad, 'not-a-token\n')
    const out = await repro(['hello', '--url', url, '--token-file', bad])
    expect(out.code).toBe(1)
  })

  it('lifetime (LIFE-578 E3) — 같은 기기 재인증 replaced · 무수신 정리 · 출력에 토큰 없음', async () => {
    const { url, store, dir } = await setup({ livenessIntervalMs: 100, idleTimeoutMs: 400 })
    const { code } = store.createCode()
    const tokenFile = path.join(dir, 'token')
    expect((await repro(['pair', '--url', url, '--code', code, '--token-out', tokenFile])).code).toBe(0)
    const out = await repro(['lifetime', '--url', url, '--token-file', tokenFile, '--idle-max-ms', '1500'])
    expect(out.code).toBe(0)
    expect(out.rows.map((row) => row.step)).toEqual(['lifetime:old-hello', 'lifetime:new-hello', 'lifetime:old-replaced', 'lifetime:new-alive', 'lifetime:idle-drop', undefined])
    expect(out.stdout).not.toContain(fs.readFileSync(tokenFile, 'utf8').trim())
  })

  it('사용법 오류는 exit 2', async () => {
    const out = await repro(['nope'])
    expect(out.code).toBe(2)
  })

  // R1-A9 — 상속된 이름(`toString` 등)은 명령이 아니다. 실행 단계 0개로 exit 0 이 되면 안 된다.
  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__'])('상속된 이름 %s 는 사용법 오류 exit 2', async (name) => {
    const out = await repro([name, '--url', 'ws://127.0.0.1:1/ws'])
    expect(out.code).toBe(2)
  })
})
