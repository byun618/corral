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
import { ListFeed } from './feed.js'
import { FIXTURE_NOW, listFixture } from './list-fixture.js'
import { MobileServer, type ChatSource, type ListSource } from './server.js'
import { CHAT_SESSIONS, SECRET_RESULT, SECRET_THOUGHT, chatListState, claudeLines } from './chat-fixture.js'
import { ChatHub } from './chat.js'

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

async function setup(timing: { livenessIntervalMs?: number; idleTimeoutMs?: number; list?: ListSource; chat?: ChatSource } = {}): Promise<{ url: string; store: PairingStore; server: MobileServer; dir: string; advance: (ms: number) => void }> {
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
      'http:GET /', 'http:GET /ws', 'http:POST /ws', 'ws:no-token', 'ws:wrong-token', 'ws:ping-before-auth', 'ws:list-before-auth', 'ws:chat-subscribe-before-auth', 'ws:chat-older-before-auth', 'ws:chat-unsubscribe-before-auth', 'ws:bad-json',
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

  it('list(LIFE-580) — 구독 스냅샷 · push · 재구독 전체 · 셸 0, 출력에 제목·토큰 없음(exit 0)', async () => {
    let state = listFixture()
    const feed = new ListFeed({ read: () => ({ state, prefs: null, now: FIXTURE_NOW }), log: () => {}, coalesceMs: 20, maxWaitMs: 50 })
    cleanups.push(() => feed.stop())
    const { url, store, dir } = await setup({ list: feed })
    const { code } = store.createCode()
    const tokenFile = path.join(dir, 'token')
    expect((await repro(['pair', '--url', url, '--code', code, '--token-out', tokenFile])).code).toBe(0)
    const recv = path.join(dir, 'recv.ndjson')
    const changer = setTimeout(() => {
      state = listFixture({ p6: { agentStatus: 'working' } })
      feed.changed()
    }, 700)
    cleanups.push(() => clearTimeout(changer))
    const out = await repro(['list', '--url', url, '--token-file', tokenFile, '--watch-ms', '2000', '--resubscribe', '--ndjson-out', recv])
    expect(out.rows.filter((row) => row.pass === false)).toEqual([])
    expect(out.code).toBe(0)
    expect(out.rows.map((row) => row.step).filter((step) => typeof step === 'string')).toEqual(['list:snapshot', 'list:seq-monotonic', 'list:no-shell', 'list:resubscribe-full'])
    const lines = fs.readFileSync(recv, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    // 재구독과 변경의 선후는 프로세스 기동 시간에 따라 갈린다 — 세 건(구독·재구독·push), 번호는 1·2 만, 역행 없음.
    const seqs = lines.map((line) => line.seq)
    expect(seqs).toHaveLength(3)
    expect(new Set(seqs)).toEqual(new Set([1, 2]))
    expect([...seqs].sort()).toEqual(seqs)
    expect(out.stdout).not.toContain('모바일 디자인 브리프 정리')
    expect(out.stdout).not.toContain(fs.readFileSync(tokenFile, 'utf8').trim())
  }, 30_000)

  it('chat(LIFE-581) — 목록에서 AI 채널을 골라 구독 · 과거 페이지 · push · 이어 받기, 출력에 글·토큰 없음(exit 0)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l581r-'))
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
    const file = path.join(root, 'claude.jsonl')
    // 과거 페이지가 생기게 턴을 늘린다(첫 페이지 40 말풍선).
    const extra = Array.from({ length: 30 }, (_, i) => [
      JSON.stringify({ parentUuid: i === 0 ? 'a11' : `ra${i - 1}`, type: 'user', message: { role: 'user', content: `반복 지시 ${i}` }, uuid: `rp${i}`, sessionId: CHAT_SESSIONS.claude.id }),
      JSON.stringify({ parentUuid: `rp${i}`, type: 'assistant', message: { id: `rm${i}`, model: 'x', content: [{ type: 'text', text: `반복 답 ${i}` }] }, uuid: `ra${i}`, sessionId: CHAT_SESSIONS.claude.id }),
    ]).flat()
    fs.writeFileSync(file, [...claudeLines(), ...extra].map((line) => `${line}\n`).join(''))
    const read = () => ({ state: chatListState(), prefs: null })
    const feed = new ListFeed({ read, log: () => {}, coalesceMs: 20, maxWaitMs: 50 })
    cleanups.push(() => feed.stop())
    const hub = new ChatHub({ read, resolveFile: ({ session }) => (session.kind === 'id' && session.id === CHAT_SESSIONS.claude.id ? file : null), log: () => {}, pollMs: 20 })
    cleanups.push(() => hub.stop())
    const { url, store, dir } = await setup({ list: feed, chat: hub })
    const { code } = store.createCode()
    const tokenFile = path.join(dir, 'token')
    expect((await repro(['pair', '--url', url, '--code', code, '--token-out', tokenFile])).code).toBe(0)
    const recv = path.join(dir, 'chat.ndjson')
    const writer = setTimeout(() => fs.appendFileSync(file, `${JSON.stringify({ parentUuid: 'ra29', type: 'user', message: { role: 'user', content: '라이브 지시' }, uuid: 'live1', sessionId: CHAT_SESSIONS.claude.id })}\n`), 900)
    cleanups.push(() => clearTimeout(writer))
    const out = await repro(['chat', '--url', url, '--token-file', tokenFile, '--older', '3', '--resume', '--watch-ms', '1500', '--ndjson-out', recv])
    expect(out.rows.filter((row) => row.pass === false)).toEqual([])
    expect(out.code).toBe(0)
    expect(out.rows.map((row) => row.step).filter((step) => typeof step === 'string')).toEqual(['chat:page', 'chat:no-duplicate-across-pages', 'chat:older', 'chat:resume', 'chat:summary'])
    const lines = fs.readFileSync(recv, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((line) => line.mode ?? line.type)).toEqual(expect.arrayContaining(['reset', 'older', 'resume']))
    expect(lines.some((line) => line.type === 'chat.items')).toBe(true)
    const text = out.stdout + fs.readFileSync(recv, 'utf8')
    for (const secret of ['반복 지시', '라이브 지시', '마지막 답', SECRET_THOUGHT, SECRET_RESULT, fs.readFileSync(tokenFile, 'utf8').trim()]) expect(text).not.toContain(secret)
  }, 30_000)

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
