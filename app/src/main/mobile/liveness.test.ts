// 서버 연결 수명 (LIFE-578 E3 · P7) — 생존 확인으로 죽은 연결 정리, 같은 기기 재인증 시 이전 연결 정리(다른 기기는 유지),
// close 없는 비정상 단절 20회 뒤에도 새 연결이 인증된다(상한 16 에 막히지 않음).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PairingStore } from './pairing.js'
import { CLOSE, IDLE_TIMEOUT_MS, LIVENESS_INTERVAL_MS, MAX_CONNECTIONS, PROTOCOL_VERSION } from './protocol.js'
import { MobileServer } from './server.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Logged = { tag: string; fields: Record<string, unknown> }

async function setup(input: { livenessIntervalMs?: number; idleTimeoutMs?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l578l-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new PairingStore({ dir: path.join(root, 'mobile') })
  store.load()
  const logs: Logged[] = []
  const server = new MobileServer({
    pairing: store,
    appVersion: '9.9.9-test',
    macName: () => '시험 맥',
    log: (tag, fields = {}) => logs.push({ tag, fields }),
    onChange: () => {},
    livenessIntervalMs: input.livenessIntervalMs,
    idleTimeoutMs: input.idleTimeoutMs,
  })
  const port = await server.start()
  cleanups.push(() => server.stop())
  return { server, store, port, logs }
}

type Client = { ws: WebSocket; next: () => Promise<Record<string, unknown>>; closed: Promise<{ code: number; at: number }> }

/** autoPong:false 면 서버 ping 에 답하지 않는다 — 망이 죽은 폰(half-open)을 흉내 낸다. */
function connect(port: number, options: { autoPong?: boolean } = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong: options.autoPong ?? true })
    const queue: Record<string, unknown>[] = []
    const waiters: ((value: Record<string, unknown>) => void)[] = []
    ws.on('message', (data) => {
      const parsed: Record<string, unknown> = JSON.parse(data.toString())
      const waiter = waiters.shift()
      if (waiter) waiter(parsed)
      else queue.push(parsed)
    })
    const closed = new Promise<{ code: number; at: number }>((done) => ws.on('close', (code) => done({ code, at: Date.now() })))
    const next = (): Promise<Record<string, unknown>> => {
      const queued = queue.shift()
      return queued ? Promise.resolve(queued) : new Promise((done) => waiters.push(done))
    }
    ws.once('open', () => resolve({ ws, next, closed }))
    ws.once('error', reject)
    cleanups.push(() => ws.terminate())
  })
}

async function pairToken(port: number, store: PairingStore, name: string): Promise<string> {
  const { code } = store.createCode()
  const client = await connect(port)
  client.ws.send(JSON.stringify({ type: 'pair', protocol: PROTOCOL_VERSION, code, name }))
  const reply = await client.next()
  if (reply.type !== 'paired' || typeof reply.token !== 'string') throw new Error('paired 모양')
  client.ws.close()
  await client.closed
  return reply.token
}

async function hello(port: number, token: string, options: { autoPong?: boolean } = {}): Promise<Client> {
  const client = await connect(port, options)
  client.ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token }))
  const reply = await client.next()
  expect(reply.type).toBe('hello')
  return client
}

/** 서버 쪽 그 기기의 열린 연결 수 — connectedDeviceIds 는 집합이라 수를 못 센다. 비공개 칸을 읽지 않고 close 로 센다. */
function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

describe('기본값 (E3)', () => {
  it('주기 10초 · 무수신 마감 30초 → 정리 최대 40초', () => {
    expect(LIVENESS_INTERVAL_MS).toBe(10_000)
    expect(IDLE_TIMEOUT_MS).toBe(30_000)
    expect(CLOSE.replaced).toBe(4006)
  })
})

describe('생존 확인 (P7ⓑ)', () => {
  it('ping 에 답하지 않는 인증 연결은 마감+주기 안에 서버가 끊는다, 답하는 연결은 남는다(양성 대조)', async () => {
    const interval = 50
    const idle = 200
    const { port, store, logs, server } = await setup({ livenessIntervalMs: interval, idleTimeoutMs: idle })
    const deadToken = await pairToken(port, store, 'dead')
    const liveToken = await pairToken(port, store, 'live')
    const startedAt = Date.now()
    const dead = await hello(port, deadToken, { autoPong: false })
    const live = await hello(port, liveToken, { autoPong: true })
    const closed = await dead.closed
    const elapsed = closed.at - startedAt
    expect(elapsed).toBeGreaterThan(idle)
    expect(elapsed).toBeLessThanOrEqual(idle + interval + 150)
    // 서버가 close 핸드셰이크 없이 끊었다(1006)
    expect(closed.code).toBe(1006)
    expect(logs.some((log) => log.tag === 'mobile.idle_drop')).toBe(true)
    // 살아 있는 연결: 메시지를 안 보내도 pong 으로 살아남는다
    await wait(idle * 2)
    expect(live.ws.readyState).toBe(WebSocket.OPEN)
    expect(server.connectedDeviceIds().size).toBe(1)
    // 로그에 토큰 없음
    expect(JSON.stringify(logs)).not.toContain(deadToken)
  })

  it('메시지를 보내는 연결은 pong 이 없어도 살아 있다(앱 ping)', async () => {
    const { port, store } = await setup({ livenessIntervalMs: 50, idleTimeoutMs: 200 })
    const token = await pairToken(port, store, 'msg')
    const client = await hello(port, token, { autoPong: false })
    for (let i = 0; i < 8; i += 1) {
      client.ws.send(JSON.stringify({ type: 'ping', id: i }))
      expect((await client.next()).type).toBe('pong')
      await wait(60)
    }
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
  })
})

describe('같은 기기 재인증 (P7ⓒ)', () => {
  it('새 hello 가 같은 기기의 이전 연결을 replaced(4006)로 닫는다 — 다른 기기 연결은 유지', async () => {
    const { port, store, server } = await setup()
    const tokenA = await pairToken(port, store, 'A')
    const tokenB = await pairToken(port, store, 'B')
    const a1 = await hello(port, tokenA, { autoPong: false })
    const b = await hello(port, tokenB)
    const a2 = await hello(port, tokenA)
    const old = await a1.next()
    expect(old).toMatchObject({ type: 'error', code: 'replaced' })
    expect((await a1.closed).code).toBe(CLOSE.replaced)
    // 다른 기기(B)와 새 연결(a2)은 그대로
    b.ws.send(JSON.stringify({ type: 'ping', id: 'b' }))
    expect(await b.next()).toMatchObject({ type: 'pong', id: 'b' })
    a2.ws.send(JSON.stringify({ type: 'ping', id: 'a2' }))
    expect(await a2.next()).toMatchObject({ type: 'pong', id: 'a2' })
    expect(server.connectedDeviceIds().size).toBe(2)
  })
})

describe('비정상 단절 20회 (P7ⓐ)', () => {
  it('close 없이 버려진 연결 20개 뒤에도 새 연결이 인증된다 — 상한 16 에 막히지 않는다', async () => {
    const { port, store } = await setup()
    const token = await pairToken(port, store, 'flip')
    const abandoned: Client[] = []
    for (let i = 0; i < 20; i += 1) {
      // 망이 바뀐 폰: 이전 소켓은 닫지 않고(서버 ping 에도 답 없음) 새 소켓으로 다시 hello
      abandoned.push(await hello(port, token, { autoPong: false }))
    }
    expect(20).toBeGreaterThan(MAX_CONNECTIONS)
    const fresh = await hello(port, token)
    fresh.ws.send(JSON.stringify({ type: 'ping', id: 'last' }))
    expect(await fresh.next()).toMatchObject({ type: 'pong', id: 'last' })
    // 버려진 20개는 전부 replaced 로 정리됐다
    const codes = await Promise.all(abandoned.map((client) => client.closed.then((closed) => closed.code)))
    expect(codes.every((code) => code === CLOSE.replaced)).toBe(true)
  })
})
