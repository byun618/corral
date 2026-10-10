// 쓰기 메시지 — 실제 서버 (LIFE-582 Z2ⓖ · P7 · P8). 인증 전 거절 · 프레임 상한(지시만 64 KiB) · 기기 id 를 붙여 넘김 · 해지 뒤 0건.
import fs from 'node:fs'
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
