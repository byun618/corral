// LIFE-577 기준 추가 R5 — A4ⓖ 페어링 실패 오류 셋(만료·이미 씀·무효) · A5ⓓ 인증 뒤 응답의 맥 이름.
// 기대값은 제품 상수가 아니라 01-criteria·SURFACE.md 에서 옮긴 리터럴이다(R1-A8 교훈).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { fallbackMacName, readMacName } from './mac-name.js'
import { PairingStore } from './pairing.js'
import { MobileServer } from './server.js'

const TTL_MS = 600_000
const EXPIRED = 'code_expired'
const USED = 'code_used'
const INVALID = 'code_invalid'
const PAIR_CLOSE = 4005
const MAC = '변상현의 MacBook Pro'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function store(now?: () => number): PairingStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l577r5-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pairing = new PairingStore({ dir: path.join(dir, 'mobile'), now })
  pairing.load()
  return pairing
}

describe('A4ⓖ 페어링 실패 오류 셋 — 저장소', () => {
  it('만료 코드(시계 주입, 정각 600000ms) → code_expired', () => {
    let now = 1_000_000
    const pairing = store(() => now)
    const { code } = pairing.createCode()
    now += TTL_MS
    expect(pairing.pair({ code, name: 'x' })).toEqual({ ok: false, reason: EXPIRED })
    // 만료 뒤 새 QR 을 만들어도 그 만료 코드는 여전히 만료로 답한다(활성 코드 실패로 세지 않는다).
    const fresh = pairing.createCode()
    expect(pairing.pair({ code, name: 'x' })).toEqual({ ok: false, reason: EXPIRED })
    expect(pairing.pair({ code: fresh.code, name: 'x' }).ok).toBe(true)
  })

  it('이미 쓴 코드 → code_used (새 코드가 있어도)', () => {
    const pairing = store()
    const { code } = pairing.createCode()
    expect(pairing.pair({ code, name: 'a' }).ok).toBe(true)
    expect(pairing.pair({ code, name: 'b' })).toEqual({ ok: false, reason: USED })
    const fresh = pairing.createCode()
    expect(pairing.pair({ code, name: 'b' })).toEqual({ ok: false, reason: USED })
    expect(pairing.pair({ code: fresh.code, name: 'b' }).ok).toBe(true)
  })

  it('그 밖은 code_invalid — 모르는 코드 · 형식 오류 · 코드 없음 · 5회 폐기 뒤 정답 · 새 QR 로 무효화된 이전 코드', () => {
    const pairing = store()
    expect(pairing.pair({ code: 'ABCDEFGH', name: 'x' })).toEqual({ ok: false, reason: INVALID })
    const first = pairing.createCode()
    expect(pairing.pair({ code: 12345678, name: 'x' })).toEqual({ ok: false, reason: INVALID })
    const second = pairing.createCode()
    if (first.code !== second.code) expect(pairing.pair({ code: first.code, name: 'x' })).toEqual({ ok: false, reason: INVALID })
    const guarded = pairing.createCode()
    for (let i = 0; i < 5; i += 1) expect(pairing.pair({ code: 'AAAAAAAA', name: 'x' })).toEqual({ ok: false, reason: INVALID })
    expect(pairing.pair({ code: guarded.code, name: 'x' })).toEqual({ ok: false, reason: INVALID })
  })

  it('스위치 끄기(clearCode) 뒤에는 쓴 코드도 code_invalid', () => {
    const pairing = store()
    const { code } = pairing.createCode()
    expect(pairing.pair({ code, name: 'a' }).ok).toBe(true)
    pairing.clearCode()
    expect(pairing.pair({ code, name: 'b' })).toEqual({ ok: false, reason: INVALID })
  })
})

type Json = Record<string, unknown>
type Client = { ws: WebSocket; next: () => Promise<{ json: Json; raw: string }>; closed: Promise<number> }

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const queue: { json: Json; raw: string }[] = []
    const waiters: ((value: { json: Json; raw: string }) => void)[] = []
    ws.on('message', (data) => {
      const raw = data.toString()
      const item = { json: JSON.parse(raw), raw }
      const waiter = waiters.shift()
      if (waiter) waiter(item)
      else queue.push(item)
    })
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)))
    ws.once('open', () => resolve({ ws, closed, next: () => { const queued = queue.shift(); return queued ? Promise.resolve(queued) : new Promise((done) => waiters.push(done)) } }))
    ws.once('error', reject)
    cleanups.push(() => ws.terminate())
  })
}

async function server(now?: () => number): Promise<{ pairing: PairingStore; port: number }> {
  const pairing = store(now)
  const mobile = new MobileServer({ pairing, appVersion: 'r5', macName: () => MAC, log: () => {}, onChange: () => {} })
  const port = await mobile.start()
  cleanups.push(() => mobile.stop())
  return { pairing, port }
}

async function pairOnce(input: { port: number; code: unknown }): Promise<{ json: Json; raw: string; close: Promise<number> }> {
  const client = await connect(input.port)
  client.ws.send(JSON.stringify({ type: 'pair', protocol: 1, code: input.code, name: 'r5' }))
  const reply = await client.next()
  return { ...reply, close: client.closed }
}

describe('A4ⓖ 페어링 실패 오류 셋 — WS', () => {
  it('만료 · 이미 씀 · 무효가 서로 다른 code 로, 모두 close 4005, 맥 이름 없음', async () => {
    let now = 2_000_000
    const { pairing, port } = await server(() => now)
    const used = pairing.createCode()
    const ok = await pairOnce({ port, code: used.code })
    expect(ok.json.type).toBe('paired')
    const reused = await pairOnce({ port, code: used.code })
    expect(reused.json).toMatchObject({ type: 'error', code: USED })
    expect(await reused.close).toBe(PAIR_CLOSE)
    const expiring = pairing.createCode()
    now += TTL_MS
    const late = await pairOnce({ port, code: expiring.code })
    expect(late.json).toMatchObject({ type: 'error', code: EXPIRED })
    expect(await late.close).toBe(PAIR_CLOSE)
    pairing.createCode()
    const unknown = await pairOnce({ port, code: 'ABCDEFGH' })
    expect(unknown.json).toMatchObject({ type: 'error', code: INVALID })
    expect(await unknown.close).toBe(PAIR_CLOSE)
    for (const reply of [reused, late, unknown]) expect(reply.raw).not.toContain(MAC)
  })
})

describe('A5ⓓ 맥 이름', () => {
  it('인증 전 응답(오류)에는 없고 paired · hello 응답에는 server.macName 으로 있다', async () => {
    const { pairing, port } = await server()
    const anon = await connect(port)
    anon.ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'nope' }))
    const denied = await anon.next()
    expect(denied.json).toMatchObject({ type: 'error', code: 'unauthorized' })
    expect(denied.raw).not.toContain(MAC)
    const early = await connect(port)
    early.ws.send(JSON.stringify({ type: 'ping' }))
    expect((await early.next()).raw).not.toContain(MAC)

    const { code } = pairing.createCode()
    const paired = await pairOnce({ port, code })
    expect(paired.json).toMatchObject({ type: 'paired', server: { app: 'corral', version: 'r5', macName: MAC } })
    const client = await connect(port)
    client.ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: paired.json.token }))
    expect((await client.next()).json).toMatchObject({ type: 'hello', ok: true, server: { app: 'corral', version: 'r5', macName: MAC } })
  })

  it('출처: scutil ComputerName → 실패하면 hostname(.local 뗌) → 그것도 비면 「Mac」', async () => {
    expect(await readMacName({ exec: async () => '  작업용 Mac\n', hostname: () => 'h.local' })).toBe('작업용 Mac')
    expect(await readMacName({ exec: async () => null, hostname: () => 'Studio.local' })).toBe('Studio')
    expect(await readMacName({ exec: async () => '\u0000\n', hostname: () => '' })).toBe('Mac')
    expect(fallbackMacName('a\u0007b.local')).toBe('ab')
    expect(fallbackMacName('x'.repeat(100))).toHaveLength(64)
  })
})
