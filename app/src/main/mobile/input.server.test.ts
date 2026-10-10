// 쓰기 메시지 — 실제 서버 (LIFE-582 Z2ⓖ · P7 · P8). 인증 전 거절 · 프레임 상한(지시만 64 KiB) · 기기 id 를 붙여 넘김 · 해지 뒤 0건.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { MAX_INPUT_BYTES } from './keys.js'
import { PairingStore } from './pairing.js'
import { CLOSE, MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from './protocol.js'
import { MobileServer, type InputSource } from './server.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Message = Record<string, unknown>
type Call = { op: string; device: string; payload: Message }

function fakeInput(): { source: InputSource; calls: Call[]; sinks: Map<string, (text: string) => void> } {
  const calls: Call[] = []
  const sinks = new Map<string, (text: string) => void>()
  const source: InputSource = {
    attach: ({ device, sink }) => {
      sinks.set(device, sink)
      return () => { if (sinks.get(device) === sink) sinks.delete(device) }
    },
    send: ({ device, ...payload }) => { calls.push({ op: 'send', device, payload }) },
    cancel: ({ device, ...payload }) => { calls.push({ op: 'cancel', device, payload }) },
    status: ({ device, ...payload }) => { calls.push({ op: 'status', device, payload }) },
    pending: ({ device }) => { calls.push({ op: 'pending', device, payload: {} }) },
    answer: ({ device, ...payload }) => { calls.push({ op: 'answer', device, payload }) },
    stopTurn: ({ device, ...payload }) => { calls.push({ op: 'stop', device, payload }) },
  }
  return { source, calls, sinks }
}

async function setup(input: { withInput?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l582s-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new PairingStore({ dir: path.join(root, 'mobile') })
  store.load()
  const fake = fakeInput()
  const server = new MobileServer({ pairing: store, appVersion: '9.9.9-test', macName: () => '시험 맥', log: () => {}, onChange: () => {}, input: input.withInput === false ? undefined : fake.source })
  const port = await server.start()
  cleanups.push(() => server.stop())
  return { server, store, port, ...fake }
}

type Client = { ws: WebSocket; messages: Message[]; next: (input?: { type?: string; timeoutMs?: number }) => Promise<Message | null>; closed: Promise<number> }

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const messages: Message[] = []
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())))
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)))
    const next = async (input: { type?: string; timeoutMs?: number } = {}): Promise<Message | null> => {
      const started = Date.now()
      for (;;) {
        const index = messages.findIndex((message) => input.type === undefined || message.type === input.type)
        if (index >= 0) return messages.splice(index, 1)[0] ?? null
        if (Date.now() - started > (input.timeoutMs ?? 2_000)) return null
        await new Promise((done) => setTimeout(done, 10))
      }
    }
    ws.once('open', () => resolve({ ws, messages, next, closed }))
    ws.once('error', reject)
    cleanups.push(() => ws.terminate())
  })
}

async function paired(port: number, store: PairingStore): Promise<{ client: Client; id: string }> {
  const client = await connect(port)
  const { code } = store.createCode()
  client.ws.send(JSON.stringify({ type: 'pair', protocol: PROTOCOL_VERSION, code, name: '폰' }))
  const reply = await client.next()
  expect(reply?.type).toBe('paired')
  const device = reply?.device
  const id = typeof device === 'object' && device !== null && 'id' in device && typeof device.id === 'string' ? device.id : ''
  return { client, id }
}

const send = (text: string) => ({ type: 'input.send', id: 'msg-0000-0001', channel: 'c1', text })

describe('인증 전 (P8)', () => {
  it('쓰기 메시지 다섯은 not_authenticated 로 닫힌다 — 공급에 닿지 않는다', async () => {
    const { port, calls } = await setup()
    const bodies: Message[] = [
      send('x'),
      { type: 'input.cancel', id: 'msg-0000-0001' },
      { type: 'input.status', ids: ['msg-0000-0001'] },
      { type: 'question.answer', id: 'msg-0000-0001', channel: 'c1', question: 1, answers: [{ choices: [0], other: null }] },
      { type: 'turn.stop', id: 'msg-0000-0001', channel: 'c1' },
    ]
    for (const body of bodies) {
      const client = await connect(port)
      client.ws.send(JSON.stringify(body))
      expect((await client.next())?.code).toBe('not_authenticated')
      expect(await client.closed).toBe(CLOSE.unauthorized)
    }
    expect(calls).toHaveLength(0)
  })
  it('인증 전 16 KiB 넘는 프레임은 1009 (지시라도)', async () => {
    const { port } = await setup()
    const client = await connect(port)
    client.ws.send(JSON.stringify(send('x'.repeat(MAX_MESSAGE_BYTES))))
    expect(await client.closed).toBe(1009)
  })
})

describe('프레임 상한 (P7)', () => {
  it('인증 뒤 지시는 65536 바이트 본문(줄바꿈 이스케이프 포함)까지 받는다', async () => {
    const { port, store, calls } = await setup()
    const { client, id } = await paired(port, store)
    const text = '\n'.repeat(MAX_INPUT_BYTES)
    client.ws.send(JSON.stringify(send(text)))
    const started = Date.now()
    while (calls.length === 0 && Date.now() - started < 2_000) await new Promise((done) => setTimeout(done, 10))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ op: 'send', device: id })
    expect(String(calls[0]?.payload.text).length).toBe(MAX_INPUT_BYTES)
  })
  it('65537 바이트 본문은 bad_message (연결은 유지)', async () => {
    const { port, store, calls } = await setup()
    const { client } = await paired(port, store)
    client.ws.send(JSON.stringify(send('가'.repeat(21846))))
    expect((await client.next({ type: 'error' }))?.code).toBe('bad_message')
    expect(calls).toHaveLength(0)
    client.ws.send(JSON.stringify({ type: 'ping', id: 1 }))
    expect((await client.next({ type: 'pong' }))?.type).toBe('pong')
  })
  it('지시가 아닌 메시지는 인증 뒤에도 16 KiB 넘으면 1009', async () => {
    const { port, store } = await setup()
    const { client } = await paired(port, store)
    client.ws.send(JSON.stringify({ type: 'ping', id: 1, pad: 'x'.repeat(MAX_MESSAGE_BYTES) }))
    expect(await client.closed).toBe(1009)
  })
})

describe('분기 · 결과 받기', () => {
  it('다섯 메시지가 기기 id 를 붙여 공급으로 가고, 공급의 결과가 그 연결로 온다', async () => {
    const { port, store, calls, sinks } = await setup()
    const { client, id } = await paired(port, store)
    client.ws.send(JSON.stringify(send('안녕')))
    client.ws.send(JSON.stringify({ type: 'input.cancel', id: 'msg-0000-0001' }))
    client.ws.send(JSON.stringify({ type: 'input.status', ids: ['msg-0000-0001', 'msg-0000-0002'] }))
    client.ws.send(JSON.stringify({ type: 'question.answer', id: 'ans-0000-0001', channel: 'c1', question: 4, answers: [{ choices: [1], other: null }] }))
    client.ws.send(JSON.stringify({ type: 'turn.stop', id: 'stp-0000-0001', channel: 'c1' }))
    const started = Date.now()
    while (calls.length < 5 && Date.now() - started < 2_000) await new Promise((done) => setTimeout(done, 10))
    expect(calls.map((call) => call.op)).toEqual(['send', 'cancel', 'status', 'answer', 'stop'])
    expect(calls.every((call) => call.device === id)).toBe(true)
    sinks.get(id)?.(JSON.stringify({ type: 'input.state', id: 'msg-0000-0001', state: 'delivered' }))
    expect((await client.next({ type: 'input.state' }))?.state).toBe('delivered')
  })
  it('키·바이트 모양 메시지는 없다 — 모르는 타입·틀린 모양은 거절', async () => {
    const { port, store, calls } = await setup()
    const { client } = await paired(port, store)
    client.ws.send(JSON.stringify({ type: 'input.keys', id: 'msg-0000-0001', channel: 'c1', keys: ['\x1b'] }))
    expect((await client.next({ type: 'error' }))?.code).toBe('unknown_type')
    client.ws.send(JSON.stringify({ type: 'input.send', id: 'short', channel: 'c1', text: 'x' }))
    expect((await client.next({ type: 'error' }))?.code).toBe('bad_message')
    client.ws.send(JSON.stringify({ type: 'question.answer', id: 'ans-0000-0001', channel: 'c1', question: 1, answers: [{ choices: [99], other: null }] }))
    expect((await client.next({ type: 'error' }))?.code).toBe('bad_message')
    expect(calls).toHaveLength(0)
  })
  it('해지 뒤에는 결과가 가지 않는다 · 공급이 없으면 unknown_type', async () => {
    const { port, store, sinks, server } = await setup()
    const { client, id } = await paired(port, store)
    store.revoke(id)
    server.disconnectDevice(id)
    await client.closed
    expect(sinks.has(id)).toBe(false)
    const bare = await setup({ withInput: false })
    const other = await paired(bare.port, bare.store)
    other.client.ws.send(JSON.stringify(send('x')))
    expect((await other.client.next({ type: 'error' }))?.code).toBe('unknown_type')
  })
})

// --- 수정 r1 ---------------------------------------------------------------------------------------

const until = async (check: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const started = Date.now()
  while (!check() && Date.now() - started < timeoutMs) await new Promise((done) => setTimeout(done, 10))
}

describe('R1-A10 수신 상한 — 인증 전은 소켓 바이트로, 인증 뒤는 모든 프레임', () => {
  it('인증 전 끝나지 않은 32 KiB 조각(fin:false)도 1009 로 닫는다', async () => {
    const { port } = await setup()
    const client = await connect(port)
    client.ws.send('x'.repeat(32 * 1024), { fin: false })
    expect(await client.closed).toBe(1009)
  })
  it('인증 뒤 16 KiB 넘는 JSON 아닌 글·바이너리는 1009 (bad_json 으로 남지 않는다)', async () => {
    const { port, store } = await setup()
    const a = await paired(port, store)
    a.client.ws.send('{' + 'x'.repeat(32 * 1024))
    expect(await a.client.closed).toBe(1009)
    const b = await paired(port, store)
    b.client.ws.send(Buffer.alloc(32 * 1024, 1))
    expect(await b.client.closed).toBe(1009)
  })
  it('인증 뒤 16 KiB 넘는 다른 모양(input.send 아님)도 1009', async () => {
    const { port, store } = await setup()
    const { client } = await paired(port, store)
    client.ws.send(JSON.stringify({ type: 'input.status', ids: [], pad: 'x'.repeat(MAX_MESSAGE_BYTES) }))
    expect(await client.closed).toBe(1009)
  })
})

describe('R2-A6 인증 전 수신 한도 = 정확히 16 KiB(선언 길이 · 조각 누계)', () => {
  it('끝나지 않은 조각 16,385 B 는 1009 — 대조: 16,384 B 는 열린 채', async () => {
    const { port } = await setup()
    const over = await connect(port)
    over.ws.send('x'.repeat(MAX_MESSAGE_BYTES + 1), { fin: false })
    expect(await over.closed).toBe(1009)
    const exact = await connect(port)
    exact.ws.send('x'.repeat(MAX_MESSAGE_BYTES), { fin: false })
    await new Promise((done) => setTimeout(done, 100))
    expect(exact.ws.readyState).toBe(WebSocket.OPEN)
    exact.ws.terminate()
  })
  it('조각 둘의 누계가 16 KiB 를 넘으면 1009', async () => {
    const { port } = await setup()
    const client = await connect(port)
    client.ws.send('x'.repeat(10_000), { fin: false })
    client.ws.send('y'.repeat(10_000), { fin: false })
    expect(await client.closed).toBe(1009)
  })
  it('길이만 32,768 B 로 선언한 머리 8 B — 본문이 오기 전에 닫는다(1009 close 프레임)', async () => {
    const { port } = await setup()
    const socket = net.createConnection(port, '127.0.0.1')
    let data = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => { data = Buffer.concat([data, chunk]) })
    await new Promise((done) => socket.once('connect', done))
    socket.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
    await until(() => data.includes('\r\n\r\n'))
    expect(data.toString('latin1').startsWith('HTTP/1.1 101')).toBe(true)
    data = Buffer.alloc(0)
    // FIN + text, MASK + 126(16비트 길이) 32768, 마스크 키 4 B — 본문 없음.
    socket.write(Buffer.from([0x81, 0xfe, 0x80, 0x00, 1, 2, 3, 4]))
    await until(() => data.length >= 4)
    // 서버 close 프레임(0x88)과 코드 1009.
    expect(data[0]).toBe(0x88)
    expect(data.readUInt16BE(2)).toBe(1009)
    socket.destroy()
  })
  it('인증 뒤에는 넓어진다 — 16 KiB 넘는 지시가 공급으로 간다', async () => {
    const { port, store, calls } = await setup()
    const { client } = await paired(port, store)
    client.ws.send(JSON.stringify({ type: 'input.send', id: 'r2a6-0000-0001', channel: 'c1', text: 'a'.repeat(40_000) }))
    await until(() => calls.length > 0)
    expect(calls[0]).toMatchObject({ op: 'send' })
  })
})

describe('R1-A11 질문 답 직접 입력 = 65536 바이트(P7) · R1-A2 도구 호출 id · R1-A8 복구 조회', () => {
  it('16 KiB 넘는 직접 입력 답은 공급으로 간다 — 도구 호출 id 와 함께', async () => {
    const { port, store, calls } = await setup()
    const { client } = await paired(port, store)
    client.ws.send(JSON.stringify({ type: 'question.answer', id: 'ans-0000-0002', channel: 'c1', question: 4, call: 'toolu-4', answers: [{ choices: [], other: 'a'.repeat(30_000) }] }))
    await until(() => calls.length > 0)
    expect(calls[0]).toMatchObject({ op: 'answer', payload: { call: 'toolu-4' } })
  })
  it('합계 65536 바이트를 넘는 직접 입력은 bad_message', async () => {
    const { port, store, calls } = await setup()
    const { client } = await paired(port, store)
    client.ws.send(JSON.stringify({ type: 'question.answer', id: 'ans-0000-0003', channel: 'c1', question: 4, call: 'toolu-4', answers: [{ choices: [], other: '가'.repeat(21_846) }] }))
    expect((await client.next({ type: 'error' }))?.code).toBe('bad_message')
    expect(calls).toHaveLength(0)
  })
  it('input.pending 은 그 기기로 공급에 간다 · 인증 전이면 닫힌다', async () => {
    const { port, store, calls } = await setup()
    const { client, id } = await paired(port, store)
    client.ws.send(JSON.stringify({ type: 'input.pending' }))
    await until(() => calls.length > 0)
    expect(calls).toEqual([{ op: 'pending', device: id, payload: {} }])
    const anon = await connect(port)
    anon.ws.send(JSON.stringify({ type: 'input.pending' }))
    expect(await anon.closed).toBe(CLOSE.unauthorized)
  })
})
