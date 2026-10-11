// 목록 구독 — 실제 서버 (LIFE-580 L1ⓐⓓⓔ · L4ⓔ · L9ⓑⓒ). 인증 전 거절 · 구독 → 스냅샷 → push · 해지·교체·닫힘 뒤 0건(양성 대조 포함).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { ListFeed } from './feed.js'
import { FIXTURE_NOW, listFixture } from './list-fixture.js'
import { PairingStore } from './pairing.js'
import { CLOSE, PROTOCOL_VERSION } from './protocol.js'
import { MobileServer } from './server.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Message = Record<string, unknown>

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l580s-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new PairingStore({ dir: path.join(root, 'mobile') })
  store.load()
  let state = listFixture()
  const reads = { count: 0 }
  const logs: { tag: string; fields: Record<string, unknown> }[] = []
  const feed = new ListFeed({
    read: () => {
      reads.count += 1
      return { state, prefs: null, now: FIXTURE_NOW }
    },
    log: (tag, fields = {}) => logs.push({ tag, fields }),
    coalesceMs: 20,
    maxWaitMs: 60,
  })
  cleanups.push(() => feed.stop())
  const server = new MobileServer({ pairing: store, appVersion: '9.9.9-test', macName: () => '시험 맥', log: (tag, fields = {}) => logs.push({ tag, fields }), onChange: () => {}, list: feed })
  const port = await server.start()
  cleanups.push(() => server.stop())
  const change = (overrides: Parameters<typeof listFixture>[0]): void => {
    state = listFixture(overrides)
    feed.changed()
  }
  return { server, store, port, feed, reads, logs, change }
}

type Client = { ws: WebSocket; messages: Message[]; next: (timeoutMs?: number) => Promise<Message | null>; closed: Promise<number> }

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const messages: Message[] = []
    const waiters: ((value: Message) => void)[] = []
    ws.on('message', (data) => {
      const parsed: Message = JSON.parse(data.toString())
      const waiter = waiters.shift()
      if (waiter) waiter(parsed)
      else messages.push(parsed)
    })
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)))
    const next = (timeoutMs = 2_000): Promise<Message | null> => {
      const queued = messages.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise((done) => {
        const waiter = (value: Message): void => {
          clearTimeout(timer)
          done(value)
        }
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1)
          done(null)
        }, timeoutMs)
        waiters.push(waiter)
      })
    }
    ws.once('open', () => resolve({ ws, messages, next, closed }))
    ws.once('error', reject)
    cleanups.push(() => ws.terminate())
  })
}

async function authed(port: number, store: PairingStore, input: { token?: string; name?: string } = {}): Promise<{ client: Client; token: string; id: string }> {
  const client = await connect(port)
  if (input.token !== undefined) {
    client.ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token: input.token }))
    const reply = await client.next()
    expect(reply?.type).toBe('hello')
    const device = reply?.device
    const id = typeof device === 'object' && device !== null && 'id' in device && typeof device.id === 'string' ? device.id : ''
    return { client, token: input.token, id }
  }
  const { code } = store.createCode()
  client.ws.send(JSON.stringify({ type: 'pair', protocol: PROTOCOL_VERSION, code, name: input.name ?? '폰' }))
  const reply = await client.next()
  expect(reply?.type).toBe('paired')
  const device = reply?.device
  const token = typeof reply?.token === 'string' ? reply.token : ''
  const id = typeof device === 'object' && device !== null && 'id' in device && typeof device.id === 'string' ? device.id : ''
  return { client, token, id }
}

const subscribe = (client: Client): void => client.ws.send(JSON.stringify({ type: 'list.subscribe' }))

describe('목록 구독 — 실제 서버', () => {
  it('L9ⓑ 인증 전 list.subscribe → not_authenticated 로 닫고 목록은 0건', async () => {
    const { port, reads } = await setup()
    const client = await connect(port)
    subscribe(client)
    expect(await client.next()).toMatchObject({ type: 'error', code: 'not_authenticated' })
    expect(await client.closed).toBe(CLOSE.unauthorized)
    expect(reads.count).toBe(0)
  })

  it('L1ⓐ 인증 뒤 구독 → 전체 스냅샷 → 변경 push, 번호 단조 증가', async () => {
    const { port, store, change } = await setup()
    const { client } = await authed(port, store)
    subscribe(client)
    const first = await client.next()
    expect(first).toMatchObject({ type: 'list', seq: 1 })
    change({ p6: { agentStatus: 'working', agentState: { observedAt: FIXTURE_NOW } } })
    const second = await client.next()
    expect(second).toMatchObject({ type: 'list', seq: 2, epoch: first?.epoch })
    change({ p6: { agentStatus: 'blocked', agentState: { blockedReason: 'question', observedAt: FIXTURE_NOW } } })
    const third = await client.next()
    expect(third?.seq).toBe(3)
  })

  it('L1ⓓ 두 기기가 같이 구독해도 스냅샷은 한 번 만든다', async () => {
    const { port, store, reads } = await setup()
    const a = await authed(port, store, { name: 'a' })
    const b = await authed(port, store, { name: 'b' })
    subscribe(a.client)
    subscribe(b.client)
    const [ma, mb] = await Promise.all([a.client.next(), b.client.next()])
    expect(ma?.seq).toBe(mb?.seq)
    expect(reads.count).toBe(1)
  })

  it('L4ⓔ 같은 연결에서 다시 구독하면(포그라운드 복귀) 전체를 다시 받는다', async () => {
    const { port, store, logs } = await setup()
    const { client } = await authed(port, store)
    subscribe(client)
    const first = await client.next()
    subscribe(client)
    const again = await client.next()
    expect(again).toMatchObject({ type: 'list', seq: first?.seq, list: first?.list })
    expect(logs.filter((entry) => entry.tag === 'mobile.list_subscribe')).toHaveLength(2)
  })

  it('L9ⓒ 해지된 기기는 해지 뒤 0건 — 살아 있는 다른 기기는 받는다(양성 대조)', async () => {
    const { server, port, store, change } = await setup()
    const gone = await authed(port, store, { name: 'gone' })
    const kept = await authed(port, store, { name: 'kept' })
    subscribe(gone.client)
    subscribe(kept.client)
    await gone.client.next()
    await kept.client.next()
    store.revoke(gone.id)
    server.disconnectDevice(gone.id)
    change({ p6: { agentStatus: 'working', agentState: { observedAt: FIXTURE_NOW } } })
    expect(await kept.client.next()).toMatchObject({ type: 'list', seq: 2 })
    const after: Message[] = []
    for (let message = await gone.client.next(300); message !== null; message = await gone.client.next(300)) after.push(message)
    expect(after.filter((message) => message.type === 'list')).toEqual([])
    expect(after.map((message) => message.code)).toEqual(['revoked'])
  })

  it('L9ⓒ 해지가 연결 닫기보다 먼저 보여도(해지만 하고 닫지 않음) 목록은 가지 않는다', async () => {
    const { port, store, change } = await setup()
    const gone = await authed(port, store, { name: 'gone' })
    subscribe(gone.client)
    await gone.client.next()
    store.revoke(gone.id)
    change({ p6: { agentStatus: 'working', agentState: { observedAt: FIXTURE_NOW } } })
    const message = await gone.client.next(500)
    expect(message).toMatchObject({ type: 'error', code: 'revoked' })
    expect(await gone.client.closed).toBe(CLOSE.revoked)
  })

  it('L9ⓒ `replaced` 된 이전 연결은 0건 — 새 연결은 받는다(양성 대조)', async () => {
    const { port, store, change, feed } = await setup()
    const first = await authed(port, store)
    subscribe(first.client)
    await first.client.next()
    const second = await authed(port, store, { token: first.token })
    expect(await first.client.next()).toMatchObject({ type: 'error', code: 'replaced' })
    subscribe(second.client)
    await second.client.next()
    change({ p6: { agentStatus: 'working', agentState: { observedAt: FIXTURE_NOW } } })
    expect(await second.client.next()).toMatchObject({ type: 'list', seq: 2 })
    expect(await first.client.next(300)).toBeNull()
    expect(feed.subscriberCount()).toBe(1)
  })

  it('닫힌 연결은 구독에서 빠진다 — 구독자 0 이면 다시 변환하지 않는다', async () => {
    const { port, store, feed, reads, change } = await setup()
    const { client } = await authed(port, store)
    subscribe(client)
    await client.next()
    client.ws.close()
    await client.closed
    await new Promise((done) => setTimeout(done, 50))
    expect(feed.subscriberCount()).toBe(0)
    const before = reads.count
    change({ p6: { agentStatus: 'working' } })
    await new Promise((done) => setTimeout(done, 150))
    expect(reads.count).toBe(before)
  })

  it('목록 공급이 없는 서버는 list.subscribe 에 unknown_type, 연결 유지', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l580s-'))
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
    const store = new PairingStore({ dir: path.join(root, 'mobile') })
    store.load()
    const server = new MobileServer({ pairing: store, appVersion: 't', macName: () => 'm', log: () => {}, onChange: () => {} })
    const port = await server.start()
    cleanups.push(() => server.stop())
    const { client } = await authed(port, store)
    subscribe(client)
    expect(await client.next()).toMatchObject({ type: 'error', code: 'unknown_type' })
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
  })
})
