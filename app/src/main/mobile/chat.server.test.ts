// 대화 구독 — 실제 서버 (LIFE-581 Y2ⓐⓑ · Y9ⓑⓒ). 인증 전 거절 · 구독 → 페이지 → push · 해지·교체 뒤 0건(양성 대조) · 목록 재구독이 대화를 끊지 않는다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { CHAT_SESSIONS, CLAUDE_SESSION, chatListState, claudeLines } from './chat-fixture.js'
import { ChatHub } from './chat.js'
import { ListFeed } from './feed.js'
import { PairingStore } from './pairing.js'
import { CLOSE, PROTOCOL_VERSION } from './protocol.js'
import { MobileServer } from './server.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Message = Record<string, unknown>

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l581s-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'claude.jsonl')
  fs.writeFileSync(file, claudeLines().map((line) => `${line}\n`).join(''))
  const store = new PairingStore({ dir: path.join(root, 'mobile') })
  store.load()
  const read = () => ({ state: chatListState(), prefs: null })
  const resolves = { count: 0 }
  const hub = new ChatHub({
    read,
    resolveFile: ({ session }) => {
      resolves.count += 1
      return session.kind === 'id' && session.id === CHAT_SESSIONS.claude.id ? file : null
    },
    log: () => {},
    pollMs: 20,
    graceMs: 50,
  })
  cleanups.push(() => hub.stop())
  const feed = new ListFeed({ read, log: () => {}, coalesceMs: 20, maxWaitMs: 60 })
  cleanups.push(() => feed.stop())
  const server = new MobileServer({ pairing: store, appVersion: '9.9.9-test', macName: () => '시험 맥', log: () => {}, onChange: () => {}, list: feed, chat: hub })
  const port = await server.start()
  cleanups.push(() => server.stop())
  return { server, store, port, hub, file, resolves }
}

type Client = { ws: WebSocket; messages: Message[]; next: (input?: { type?: string; timeoutMs?: number }) => Promise<Message | null>; closed: Promise<number> }

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const messages: Message[] = []
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())))
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)))
    /** 다음 메시지(종류를 주면 그 종류의 다음 것) — 읽은 것은 큐에서 뺀다. */
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

async function authed(port: number, input: { store: PairingStore; token?: string }): Promise<{ client: Client; token: string; id: string }> {
  const client = await connect(port)
  if (input.token !== undefined) {
    client.ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, token: input.token }))
    const reply = await client.next()
    expect(reply?.type).toBe('hello')
    const device = reply?.device
    const id = typeof device === 'object' && device !== null && 'id' in device && typeof device.id === 'string' ? device.id : ''
    return { client, token: input.token, id }
  }
  const { code } = input.store.createCode()
  client.ws.send(JSON.stringify({ type: 'pair', protocol: PROTOCOL_VERSION, code, name: '폰' }))
  const reply = await client.next()
  expect(reply?.type).toBe('paired')
  const device = reply?.device
  const id = typeof device === 'object' && device !== null && 'id' in device && typeof device.id === 'string' ? device.id : ''
  return { client, token: typeof reply?.token === 'string' ? reply.token : '', id }
}

const send = (client: Client, message: Message): void => client.ws.send(JSON.stringify(message))
const appendPrompt = (file: string, text: string, uuid: string): void =>
  fs.appendFileSync(file, `${JSON.stringify({ parentUuid: 'a11', type: 'user', message: { role: 'user', content: text }, uuid, timestamp: new Date().toISOString(), sessionId: CLAUDE_SESSION })}\n`)

describe('대화 구독 — 실제 서버', () => {
  it('Y9ⓑ 인증 전 chat.subscribe·chat.older·chat.unsubscribe → not_authenticated 로 닫고 판독 0', async () => {
    const { port, resolves, hub } = await setup()
    for (const message of [{ type: 'chat.subscribe', channel: 'c1' }, { type: 'chat.older', gen: 'g', before: 1 }, { type: 'chat.unsubscribe' }]) {
      const client = await connect(port)
      send(client, message)
      expect(await client.next()).toMatchObject({ type: 'error', code: 'not_authenticated' })
      expect(await client.closed).toBe(CLOSE.unauthorized)
    }
    expect(resolves.count).toBe(0)
    expect(hub.readerCount()).toBe(0)
  })

  it('Y2ⓐ 인증 뒤 구독 → 첫 페이지 → 새 줄 push · 모양이 틀린 구독은 bad_message(연결 유지)', async () => {
    const { port, store, file } = await setup()
    const { client } = await authed(port, { store })
    send(client, { type: 'chat.subscribe' })
    expect(await client.next()).toMatchObject({ type: 'error', code: 'bad_message' })
    send(client, { type: 'chat.subscribe', channel: 'c1' })
    const page = await client.next({ type: 'chat.page' })
    expect(page).toMatchObject({ type: 'chat.page', mode: 'reset', channel: 'c1' })
    appendPrompt(file, '서버 시험 지시', 'X1')
    const pushed = await client.next({ type: 'chat.items' })
    expect(JSON.stringify(pushed)).toContain('서버 시험 지시')
  })

  it('목록 재구독(포그라운드 복귀)은 열린 대화를 끊지 않는다 · chat.unsubscribe 는 끊는다', async () => {
    const { port, store, file, hub } = await setup()
    const { client } = await authed(port, { store })
    send(client, { type: 'chat.subscribe', channel: 'c1' })
    await client.next({ type: 'chat.page' })
    send(client, { type: 'list.subscribe' })
    await client.next({ type: 'list' })
    appendPrompt(file, '재구독 뒤 지시', 'X2')
    expect(JSON.stringify(await client.next({ type: 'chat.items' }))).toContain('재구독 뒤 지시')
    send(client, { type: 'chat.unsubscribe' })
    await new Promise((done) => setTimeout(done, 50))
    expect(hub.subscriberCount()).toBe(0)
    appendPrompt(file, '끊은 뒤 지시', 'X3')
    expect(await client.next({ type: 'chat.items', timeoutMs: 300 })).toBeNull()
  })

  it('Y9ⓒ 해지된 기기 · replaced 된 이전 연결엔 그 뒤 대화 0건 — 살아 있는 연결은 받는다(양성 대조)', async () => {
    const { port, store, server, file } = await setup()
    const doomed = await authed(port, { store })
    const keeper = await authed(port, { store })
    const old = await authed(port, { store })
    for (const client of [doomed.client, keeper.client, old.client]) {
      send(client, { type: 'chat.subscribe', channel: 'c1' })
      expect(await client.next({ type: 'chat.page' })).not.toBeNull()
    }
    // old 기기가 새 연결로 다시 인증 → 이전 연결 replaced
    const fresh = await authed(port, { store, token: old.token })
    expect(await old.client.next({ type: 'error' })).toMatchObject({ code: 'replaced' })
    expect(store.revoke(doomed.id)).toBe(true)
    server.disconnectDevice(doomed.id)
    expect(await doomed.client.next({ type: 'error' })).toMatchObject({ code: 'revoked' })
    send(fresh.client, { type: 'chat.subscribe', channel: 'c1' })
    await fresh.client.next({ type: 'chat.page' })
    appendPrompt(file, '해지 뒤 지시', 'X4')
    expect(JSON.stringify(await keeper.client.next({ type: 'chat.items' }))).toContain('해지 뒤 지시')
    expect(JSON.stringify(await fresh.client.next({ type: 'chat.items' }))).toContain('해지 뒤 지시')
    expect(doomed.client.messages.filter((message) => message.type === 'chat.items')).toEqual([])
    expect(old.client.messages.filter((message) => message.type === 'chat.items')).toEqual([])
  })

  // R1-A11 — 위 시험은 해지 직후 disconnectDevice 를 바로 불러 연결이 먼저 닫힌다. 보내기 직전 재확인(`pairing.has`)만 남는 구간을 따로 본다(리뷰어 경합 시험).
  it('R1-A11 해지만 되고 연결 끊기가 아직이면 — 다음 push 자리에서 revoked 로 닫고 대화 0건', async () => {
    const { port, store, file } = await setup()
    const target = await authed(port, { store })
    send(target.client, { type: 'chat.subscribe', channel: 'c1' })
    expect(await target.client.next({ type: 'chat.page' })).not.toBeNull()
    expect(store.revoke(target.id)).toBe(true)
    // disconnectDevice 를 일부러 부르지 않는다 — 보내기 직전의 has(deviceId) 재확인만 남긴다.
    appendPrompt(file, '해지 구간의 지시', 'R11')
    expect(await target.client.next()).toMatchObject({ type: 'error', code: 'revoked' })
    expect(target.client.messages.filter((message) => message.type === 'chat.items')).toEqual([])
  })

  it('Y2ⓑ 목록에 없는 채널·셸 pane 은 chat.unavailable — 같은 연결의 AI 채널은 열린다', async () => {
    const { port, store } = await setup()
    const { client } = await authed(port, { store })
    send(client, { type: 'chat.subscribe', channel: 's1' })
    expect(await client.next()).toMatchObject({ type: 'chat.unavailable', reason: 'not_listed' })
    send(client, { type: 'chat.subscribe', channel: '/etc/passwd' })
    expect(await client.next()).toMatchObject({ type: 'chat.unavailable', reason: 'not_listed' })
    send(client, { type: 'chat.subscribe', channel: 'c1' })
    expect(await client.next({ type: 'chat.page' })).toMatchObject({ channel: 'c1' })
  })
})
