import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PairingStore, PAIRING_TTL_MS } from './pairing.js'
import { CLOSE, MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from './protocol.js'
import { MOBILE_BIND_HOST, MobileServer } from './server.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Logged = { tag: string; fields: Record<string, unknown> }

async function setup(input: { now?: () => number; authTimeoutMs?: number } = {}): Promise<{ server: MobileServer; store: PairingStore; port: number; logs: Logged[]; dir: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l577s-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'mobile')
  const store = new PairingStore({ dir, now: input.now })
  store.load()
  const logs: Logged[] = []
  const server = new MobileServer({
    pairing: store,
    appVersion: '9.9.9-test',
    macName: () => '시험 맥',
    log: (tag, fields = {}) => logs.push({ tag, fields }),
    onChange: () => {},
    authTimeoutMs: input.authTimeoutMs,
  })
  const port = await server.start()
  cleanups.push(() => server.stop())
  return { server, store, port, logs, dir }
}

type Client = { ws: WebSocket; messages: Record<string, unknown>[]; next: () => Promise<Record<string, unknown>>; closed: Promise<{ code: number; at: number }> }

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const messages: Record<string, unknown>[] = []
    const waiters: ((value: Record<string, unknown>) => void)[] = []
    ws.on('message', (data) => {
      const parsed: Record<string, unknown> = JSON.parse(data.toString())
      const waiter = waiters.shift()
      if (waiter) waiter(parsed)
      else messages.push(parsed)
    })
    const closed = new Promise<{ code: number; at: number }>((done) => ws.on('close', (code) => done({ code, at: Date.now() })))
    const next = (): Promise<Record<string, unknown>> => {
      const queued = messages.shift()
      return queued ? Promise.resolve(queued) : new Promise((done) => waiters.push(done))
    }
    ws.once('open', () => resolve({ ws, messages, next, closed }))
    ws.once('error', reject)
    cleanups.push(() => ws.terminate())
  })
}

async function pairDevice(port: number, store: PairingStore, name: string): Promise<{ token: string; client: Client; id: string }> {
  const { code } = store.createCode()
  const client = await connect(port)
  client.ws.send(JSON.stringify({ type: 'pair', protocol: PROTOCOL_VERSION, code, name }))
  const reply = await client.next()
  expect(reply.type).toBe('paired')
  const token = reply.token
  const device = reply.device
  if (typeof token !== 'string' || typeof device !== 'object' || device === null || !('id' in device) || typeof device.id !== 'string') throw new Error('paired 모양')
  return { token, client, id: device.id }
}

function rawHttp(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request))
    let out = ''
    socket.on('data', (chunk) => { out += chunk.toString() })
    socket.on('end', () => resolve(out))
    socket.on('close', () => resolve(out))
    socket.on('error', reject)
  })
}

describe('바인딩·HTTP 표면 (A2·A3ⓑ)', () => {
  it('127.0.0.1 에만 리슨한다', async () => {
    const { server } = await setup()
    expect(MOBILE_BIND_HOST).toBe('127.0.0.1')
    expect(server.listeningPort()).toBeGreaterThan(0)
  })

  it('WS 가 아닌 HTTP 는 경로·메서드 무관 404 본문 없음', async () => {
    const { port } = await setup()
    for (const [method, url] of [['GET', '/'], ['GET', '/ws'], ['POST', '/ws'], ['GET', '/status'], ['PUT', '/anything'], ['OPTIONS', '*']] as const) {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, method, path: url }, (res) => {
          let body = ''
          res.on('data', (chunk) => { body += chunk })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        })
        request.on('error', reject)
        request.end()
      })
      expect(response).toEqual({ status: 404, body: '' })
    }
  })

  it('다른 경로로의 WS 업그레이드는 404', async () => {
    const { port } = await setup()
    const out = await rawHttp(port, 'GET /other HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n') // gitleaks:allow — RFC 6455 §1.3 예제 키
    expect(out.startsWith('HTTP/1.1 404')).toBe(true)
  })
})

describe('인증 거절 행렬 (A3ⓑ) · 양성 대조', () => {
  it('토큰 없음 · 틀린 토큰 → unauthorized 로 닫힘, 버전도 알려 주지 않는다', async () => {
    const { port } = await setup()
    for (const token of [undefined, 'wrong-token']) {
      const client = await connect(port)
      client.ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token }))
      const reply = await client.next()
      expect(reply).toMatchObject({ type: 'error', code: 'unauthorized' })
      expect(JSON.stringify(reply)).not.toContain('9.9.9-test')
      expect((await client.closed).code).toBe(CLOSE.unauthorized)
    }
  })

  it('인증 전 다른 메시지(ping·모르는 타입) → not_authenticated 로 닫힘', async () => {
    const { port } = await setup()
    for (const message of [{ type: 'ping' }, { type: 'state' }]) {
      const client = await connect(port)
      client.ws.send(JSON.stringify(message))
      expect(await client.next()).toMatchObject({ type: 'error', code: 'not_authenticated' })
      expect((await client.closed).code).toBe(CLOSE.unauthorized)
    }
  })

  it('JSON 아님 · 모양 틀림 → 닫힘', async () => {
    const { port } = await setup()
    const cases: [string, string][] = [['not json', 'bad_json'], ['[]', 'bad_message'], ['{"type":"hello"}', 'bad_message']]
    for (const [text, code] of cases) {
      const client = await connect(port)
      client.ws.send(text)
      expect(await client.next()).toMatchObject({ type: 'error', code })
      expect((await client.closed).code).toBe(CLOSE.badMessage)
    }
  })

  it('프로토콜 불일치 → protocol_mismatch + 지원 버전 (A5ⓒ)', async () => {
    const { port } = await setup()
    const client = await connect(port)
    client.ws.send(JSON.stringify({ type: 'hello', protocol: 999, token: 'x' }))
    expect(await client.next()).toEqual({ type: 'error', code: 'protocol_mismatch', message: expect.any(String), supported: [PROTOCOL_VERSION] })
    expect((await client.closed).code).toBe(CLOSE.protocolMismatch)
  })

  it('pair → paired(토큰·버전) → hello → ping/pong · 인증 뒤 모르는 타입은 오류만 (A5ⓐⓑ)', async () => {
    const { port, store } = await setup()
    const { token } = await pairDevice(port, store, '시험 폰')
    const client = await connect(port)
    client.ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token }))
    expect(await client.next()).toMatchObject({ type: 'hello', ok: true, protocol: PROTOCOL_VERSION, server: { app: 'corral', version: '9.9.9-test', macName: '시험 맥' }, device: { name: '시험 폰' } })
    client.ws.send(JSON.stringify({ type: 'ping', id: 7 }))
    expect(await client.next()).toMatchObject({ type: 'pong', id: 7 })
    client.ws.send(JSON.stringify({ type: 'state' }))
    expect(await client.next()).toMatchObject({ type: 'error', code: 'unknown_type' })
    client.ws.send(JSON.stringify({ type: 'ping' }))
    expect(await client.next()).toMatchObject({ type: 'pong' })
  })

  it('사용한 코드 → code_used · 만료 코드 → code_expired · 5회 틀린 뒤 정답 → code_invalid (A4ⓖ)', async () => {
    let now = 5_000_000
    const { port, store } = await setup({ now: () => now })
    // 사용한 코드
    const { code } = store.createCode()
    const first = await connect(port)
    first.ws.send(JSON.stringify({ type: 'pair', protocol: PROTOCOL_VERSION, code, name: 'a' }))
    expect(await first.next()).toMatchObject({ type: 'paired' })
    const reused = await connect(port)
    reused.ws.send(JSON.stringify({ type: 'pair', protocol: PROTOCOL_VERSION, code, name: 'b' }))
    expect(await reused.next()).toMatchObject({ type: 'error', code: 'code_used' })
    expect((await reused.closed).code).toBe(CLOSE.pairRejected)
    // 만료 코드
    const expiring = store.createCode()
    now += PAIRING_TTL_MS
    const late = await connect(port)
    late.ws.send(JSON.stringify({ type: 'pair', protocol: PROTOCOL_VERSION, code: expiring.code, name: 'c' }))
    expect(await late.next()).toMatchObject({ type: 'error', code: 'code_expired' })
    // 5회 틀린 뒤 정답
    const guarded = store.createCode()
    for (let i = 0; i < 5; i += 1) {
      const wrong = await connect(port)
      wrong.ws.send(JSON.stringify({ type: 'pair', protocol: PROTOCOL_VERSION, code: 'AAAAAAAA', name: 'x' }))
      expect(await wrong.next()).toMatchObject({ type: 'error', code: 'code_invalid' })
    }
    const right = await connect(port)
    right.ws.send(JSON.stringify({ type: 'pair', protocol: PROTOCOL_VERSION, code: guarded.code, name: 'x' }))
    expect(await right.next()).toMatchObject({ type: 'error', code: 'code_invalid' })
  })

  it('해지: 그 기기의 열린 WS 가 1초 안에 닫히고 새 연결 거절, 다른 기기는 유지 (A4ⓔ)', async () => {
    const { port, store, server } = await setup()
    const a = await pairDevice(port, store, 'a')
    const b = await pairDevice(port, store, 'b')
    store.revoke(a.id)
    const at = Date.now()
    server.disconnectDevice(a.id)
    expect(await a.client.next()).toMatchObject({ type: 'error', code: 'revoked' })
    const closed = await a.client.closed
    expect(closed.code).toBe(CLOSE.revoked)
    expect(closed.at - at).toBeLessThan(1000)
    b.client.ws.send(JSON.stringify({ type: 'ping', id: 'b' }))
    expect(await b.client.next()).toMatchObject({ type: 'pong', id: 'b' })
    const again = await connect(port)
    again.ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token: a.token }))
    expect(await again.next()).toMatchObject({ type: 'error', code: 'unauthorized' })
  })
})

describe('시간 제한·크기 상한 (A3ⓒ)', () => {
  it('미인증 연결은 시간 제한 뒤 auth_timeout 으로 닫힌다', async () => {
    const { port } = await setup({ authTimeoutMs: 200 })
    const client = await connect(port)
    const opened = Date.now()
    expect(await client.next()).toMatchObject({ type: 'error', code: 'auth_timeout' })
    const closed = await client.closed
    expect(closed.code).toBe(CLOSE.authTimeout)
    expect(closed.at - opened).toBeGreaterThanOrEqual(150)
  })

  it('상한을 넘는 프레임은 1009 로 닫힌다', async () => {
    const { port } = await setup()
    const client = await connect(port)
    client.ws.send('x'.repeat(MAX_MESSAGE_BYTES + 1))
    expect((await client.closed).code).toBe(1009)
  })
})

describe('비밀 비노출 (A3ⓓ)', () => {
  it('로그·기기 파일에 토큰·코드 원문이 없다', async () => {
    const { port, store, logs, dir } = await setup()
    const { code } = store.createCode()
    const client = await connect(port)
    client.ws.send(JSON.stringify({ type: 'pair', protocol: PROTOCOL_VERSION, code, name: 'p' }))
    const reply = await client.next()
    const token = String(reply.token)
    const hello = await connect(port)
    hello.ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token }))
    await hello.next()
    const logText = JSON.stringify(logs)
    expect(logText).not.toContain(token)
    expect(logText).not.toContain(code)
    const fileText = fs.readFileSync(path.join(dir, 'devices.json'), 'utf8')
    expect(fileText).not.toContain(token)
    expect(fileText).not.toContain(code)
  })
})

describe('정지', () => {
  it('stop 뒤 포트가 닫힌다', async () => {
    const { server, port } = await setup()
    await server.stop()
    await expect(connect(port)).rejects.toBeTruthy()
  })
})
