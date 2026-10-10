// 대화 (LIFE-581) — 메시지 읽기 · 합치기 · 구독/이어 받기(X6) · 늦은 갱신 거절(Y5ⓑ) · 실패 상태(Y6ⓔ) · 표시 규칙(Y6ⓓ).
import { describe, expect, it } from 'vitest'
import { mergeItems, parseChatMessage, readChatItem, type ChatItem } from '../src/core/chat'
import { CHAT_DEADLINE_MS, ChatStore } from '../src/core/chat-store'
import { bodyState, foldText, inlineSpans, markdownBlocks, noteView, questionLine, replyHeads, runningTool, toolSummary } from '../src/core/chat-view'
import { ConnectionManager } from '../src/core/connection'
import { ListStore } from '../src/core/list-store'
import { UnreadLedger, type UnreadData } from '../src/core/unread'
import { ConnectionLog } from '../src/core/log'
import { parseServerMessage } from '../src/core/protocol'
import { FakeClock, FakeSocket, MemoryVault, SERVER, record } from './fakes'

const prompt = (id: number, text = `지시 ${id}`): ChatItem => ({ id, kind: 'prompt', at: 1_000 + id, body: { text, clipped: null } })
const reply = (id: number, text = `답 ${id}`): ChatItem => ({ id, kind: 'reply', at: 1_000 + id, body: { text, clipped: null } })

function page(input: { gen?: string; mode?: 'reset' | 'resume' | 'older'; hasOlder?: boolean; items: unknown[]; channel?: string; cursor?: number }): Record<string, unknown> {
  return { type: 'chat.page', channel: input.channel ?? 'c1', gen: input.gen ?? 'g1', cursor: input.cursor ?? 1, mode: input.mode ?? 'reset', at: 9, writtenAt: 8, hasOlder: input.hasOlder ?? false, items: input.items }
}
function items(input: { gen?: string; items: ChatItem[]; channel?: string; cursor?: number }): Record<string, unknown> {
  return { type: 'chat.items', channel: input.channel ?? 'c1', gen: input.gen ?? 'g1', cursor: input.cursor ?? 2, at: 9, readAt: 9, writtenAt: 8, items: input.items }
}

function harness() {
  const clock = new FakeClock()
  const sockets: FakeSocket[] = []
  const log = new ConnectionLog(() => clock.now())
  const manager = new ConnectionManager({
    openSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    vault: new MemoryVault(record()),
    clock,
    log,
    appVersion: '0.1.0',
    deviceName: 'Z Flip7',
  })
  const store = new ChatStore({ connection: manager, now: () => clock.now(), timer: clock, log })
  const last = (): FakeSocket => {
    const socket = sockets[sockets.length - 1]
    if (socket === undefined) throw new Error('소켓 없음')
    return socket
  }
  const accept = (): FakeSocket => {
    const socket = last()
    socket.serverOpen()
    socket.serverSend({ type: 'hello', ok: true, protocol: 1, server: SERVER, device: { id: 'dev1', name: 'Z Flip7' } })
    return socket
  }
  const chatSent = (socket: FakeSocket) => socket.sent.filter((message) => String(message.type).startsWith('chat.'))
  return { clock, sockets, manager, store, last, accept, log, chatSent }
}

describe('메시지 읽기', () => {
  it('page·items·unavailable 를 읽고 모양이 틀린 말풍선만 버린다(개수는 dropped)', () => {
    const parsed = parseServerMessage(JSON.stringify(page({ items: [prompt(1), { id: 'x', kind: 'prompt' }, { id: 2, kind: 'sparkly' }, reply(3)] })))
    expect(parsed.type).toBe('chat')
    if (parsed.type !== 'chat' || parsed.message.type !== 'page') throw new Error('page 아님')
    expect(parsed.message.items.map((item) => item.id)).toEqual([1, 3])
    expect(parsed.message.dropped).toBe(2)
    // R2-A4 — `retrying` 칸이 생겼다(없으면 false). 기존 기대에 그 칸만 더했다.
    expect(parseChatMessage({ type: 'chat.unavailable', channel: 'c1', reason: 'no_file' })).toEqual({ type: 'unavailable', channel: 'c1', reason: 'no_file', retrying: false })
    expect(parseServerMessage(JSON.stringify({ type: 'chat.page', channel: 'c1', items: [] }))).toEqual({ type: 'chat_invalid' })
  })

  it('도구 묶음·질문·안내 말풍선', () => {
    expect(readChatItem({ id: 4, kind: 'tools', at: null, tools: [{ name: 'Read', target: 'a.ts', status: 'ok' }], count: 1, names: { Read: 1 }, detail: true })).toMatchObject({ kind: 'tools', count: 1 })
    expect(readChatItem({ id: 4, kind: 'tools', tools: [{ name: 'Read', status: 'weird' }], count: 1, names: {}, detail: true })).toBeNull()
    expect(readChatItem({ id: 5, kind: 'question', questions: [{ question: '어느 쪽?', header: null, options: [{ label: 'A' }] }], state: 'answered', answer: 'A' })).toMatchObject({ state: 'answered', answer: 'A' })
    expect(readChatItem({ id: 6, kind: 'note', note: 'compacted' })).toMatchObject({ note: 'compacted', text: null })
  })

  it('mergeItems — 같은 id 는 새 값이 이기고 결과는 id 순', () => {
    const merged = mergeItems({ have: [prompt(1), reply(2, '짧은')], incoming: [reply(2, '자란 답'), prompt(0.5), reply(3)] })
    expect(merged.map((item) => item.id)).toEqual([0.5, 1, 2, 3])
    expect(merged[2]).toMatchObject({ body: { text: '자란 답' } })
  })
})

describe('구독 · 이어 받기 (X6)', () => {
  it('열면 chat.subscribe · 첫 페이지 전에는 loading(빈 대화 아님) · push 를 합친다 · 닫으면 chat.unsubscribe', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    t.store.open('c1')
    expect(t.chatSent(socket)).toEqual([{ type: 'chat.subscribe', channel: 'c1' }])
    expect(bodyState({ phase: t.store.getSnapshot().phase, count: 0 }).kind).toBe('loading')
    socket.serverSend(page({ items: [prompt(1), reply(2)], hasOlder: true }))
    expect(t.store.getSnapshot()).toMatchObject({ phase: { kind: 'ready' }, gen: 'g1', hasOlder: true })
    socket.serverSend(items({ items: [reply(2, '더 자람'), prompt(3)] }))
    expect(t.store.getSnapshot().items.map((item) => item.id)).toEqual([1, 2, 3])
    t.store.close('c1')
    expect(socket.lastSent()).toEqual({ type: 'chat.unsubscribe' })
    expect(t.store.getSnapshot().phase.kind).toBe('idle')
  })

  it('연결 전에 열면 인증 직후 구독한다', async () => {
    const t = harness()
    t.store.open('c1')
    await t.manager.start()
    const socket = t.accept()
    expect(t.chatSent(socket)).toEqual([{ type: 'chat.subscribe', channel: 'c1' }])
  })

  // r1(R1-A2): 이어 받기 열쇠가 「마지막 id(after)」 에서 「첫 id(from) + 받은 변경 순번(cursor)」 으로 바뀌어 기대 요청 모양을 바꿨다.
  it('재연결하면 사용자 조작 없이 같은 세대 + 첫 id + 변경 순번으로 다시 구독 · resume 페이지를 이어 붙인다', async () => {
    const t = harness()
    await t.manager.start()
    const first = t.accept()
    t.store.open('c1')
    first.serverSend(page({ items: [prompt(1), reply(2)] }))
    first.serverClose(1006)
    t.clock.advance(5_000)
    const second = t.accept()
    expect(second).not.toBe(first)
    expect(t.chatSent(second)).toEqual([{ type: 'chat.subscribe', channel: 'c1', gen: 'g1', from: 1, cursor: 1 }])
    // 끊긴 동안 보던 말풍선은 그대로(C18 — 흐리게만).
    expect(t.store.getSnapshot().items).toHaveLength(2)
    second.serverSend(page({ mode: 'resume', items: [prompt(3), reply(4)] }))
    expect(t.store.getSnapshot().items.map((item) => item.id)).toEqual([1, 2, 3, 4])
  })

  it('세대가 바뀌면(서버 reset) 처음부터 받는다', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    t.store.open('c1')
    socket.serverSend(page({ items: [prompt(1), reply(2), prompt(3)] }))
    socket.serverSend(page({ gen: 'g2', items: [prompt(1)] }))
    expect(t.store.getSnapshot()).toMatchObject({ gen: 'g2' })
    expect(t.store.getSnapshot().items.map((item) => item.id)).toEqual([1])
  })

  it('Y5ⓑ 늦은 갱신 — 다른 채널·다른 세대의 프레임은 버린다 · 이전 소켓은 핸들러가 떼어져 닿지 않는다(양성 대조: 같은 프레임이 맞으면 받는다)', async () => {
    const t = harness()
    await t.manager.start()
    const first = t.accept()
    t.store.open('c1')
    first.serverSend(page({ items: [prompt(1)] }))
    first.serverClose(1006)
    t.clock.advance(5_000)
    const second = t.accept()
    second.serverSend(page({ mode: 'resume', items: [] }))
    expect(first.onmessage).toBeNull()
    const before = t.store.dropped
    second.serverSend(items({ channel: 'c2', items: [reply(9)] }))
    second.serverSend(items({ gen: 'old', items: [reply(9)] }))
    expect(t.store.dropped - before).toBe(2)
    expect(t.store.getSnapshot().items.map((item) => item.id)).toEqual([1])
    second.serverSend(items({ items: [reply(9)] }))
    expect(t.store.getSnapshot().items.map((item) => item.id)).toEqual([1, 9])
  })

  it('Y5ⓑ 지금 시도가 아닌 번호의 chat 신호는 버린다(경합 — 핸들러가 남아 있어도)', () => {
    type Listener = Parameters<ConnectionManager['onSession']>[0]
    const listeners: Listener[] = []
    const sent: Record<string, unknown>[] = []
    const clock = new FakeClock()
    const store = new ChatStore({
      connection: { onSession: (listener) => { listeners.push(listener); return () => {} }, liveAttempt: () => 2, send: (message) => { sent.push(message); return true }, clockSample: () => null },
      now: () => clock.now(),
      timer: clock,
    })
    const emit = (event: Parameters<Listener>[0]): void => listeners.forEach((listener) => listener(event))
    store.open('c1')
    const message = parseChatMessage(page({ items: [prompt(1)] }))
    if (message === null) throw new Error('읽지 못함')
    emit({ kind: 'chat', attempt: 1, message })
    expect(store.getSnapshot().phase.kind).toBe('loading')
    expect(store.dropped).toBe(1)
    emit({ kind: 'chat', attempt: 2, message })
    expect(store.getSnapshot().phase.kind).toBe('ready')
  })

  it('과거 페이지 — 첫 말풍선 앞을 청하고 앞에 붙인다 · 끝이면 더 청하지 않는다', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    t.store.open('c1')
    socket.serverSend(page({ items: [prompt(10), reply(11)], hasOlder: true }))
    expect(t.store.loadOlder()).toBe(true)
    expect(socket.lastSent()).toEqual({ type: 'chat.older', gen: 'g1', before: 10 })
    expect(t.store.loadOlder()).toBe(false)
    socket.serverSend(page({ mode: 'older', items: [prompt(1), reply(2)], hasOlder: false }))
    expect(t.store.getSnapshot()).toMatchObject({ hasOlder: false, loadingOlder: false })
    expect(t.store.getSnapshot().items.map((item) => item.id)).toEqual([1, 2, 10, 11])
    expect(t.store.loadOlder()).toBe(false)
  })

  it('못 여는 사유·응답 없음·서버가 모름은 각각 실패 상태 — 빈 대화로 그리지 않는다', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    t.store.open('c1')
    socket.serverSend({ type: 'chat.unavailable', channel: 'c1', reason: 'no_file' })
    expect(bodyState({ phase: t.store.getSnapshot().phase, count: 0 })).toMatchObject({ kind: 'failed', retry: false })

    t.store.close('c1')
    t.store.open('c2')
    t.clock.advance(CHAT_DEADLINE_MS + 1)
    expect(t.store.getSnapshot().phase).toEqual({ kind: 'failed', reason: 'timeout' })
    expect(bodyState({ phase: t.store.getSnapshot().phase, count: 0 })).toMatchObject({ kind: 'failed', retry: true })
    t.store.retry()
    expect(t.chatSent(socket).filter((message) => message.channel === 'c2')).toHaveLength(2)
    expect(t.store.getSnapshot().phase.kind).toBe('loading')

    socket.serverSend({ type: 'error', code: 'unknown_type', message: 'x' })
    expect(t.store.getSnapshot().phase).toEqual({ kind: 'failed', reason: 'rejected' })
  })

  it('대화를 모르는 옛 서버(LIFE-580) — 대화는 rejected, 목록은 실패로 만들지 않는다(오류가 목록 앞·뒤 어느 쪽에 와도) · 목록도 모르는 서버면 목록 rejected(양성 대조)', async () => {
    for (const order of ['list-first', 'error-first', 'no-list'] as const) {
      const t = harness()
      const unread: { data: UnreadData | null; load(): UnreadData | null; save(data: UnreadData): void } = { data: null, load: () => null, save: () => {} }
      const list = new ListStore({ connection: t.manager, ledger: new UnreadLedger({ store: unread, now: () => t.clock.now() }), now: () => t.clock.now(), timer: t.clock })
      t.store.open('c1')
      await t.manager.start()
      const socket = t.accept()
      const listFrame = { type: 'list', epoch: 'e', seq: 1, at: 1, changedAt: 1, list: { available: true, repos: [], waiting: [] } }
      if (order === 'list-first') socket.serverSend(listFrame)
      socket.serverSend({ type: 'error', code: 'unknown_type', message: 'x' })
      if (order === 'error-first') socket.serverSend(listFrame)
      expect(t.store.getSnapshot().phase).toEqual({ kind: 'failed', reason: 'rejected' })
      if (order === 'no-list') expect(list.getSnapshot().failure).toMatchObject({ reason: 'rejected' })
      else expect([order, list.getSnapshot().failure]).toEqual([order, null])
    }
  })

  it('받은 기록(chat_recv)에 글이 없다', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    t.store.open('c1')
    socket.serverSend(page({ items: [prompt(1, 'SECRET_PROMPT_TEXT'), reply(2, 'SECRET_REPLY_TEXT')] }))
    const dump = JSON.stringify(t.log.list())
    expect(dump).toContain('chat_recv')
    expect(dump).not.toContain('SECRET_')
  })
})

describe('표시 규칙 (Y6ⓓ)', () => {
  const tools = (patch: Partial<Extract<ChatItem, { kind: 'tools' }>> = {}): Extract<ChatItem, { kind: 'tools' }> => ({
    id: 1,
    kind: 'tools',
    at: null,
    tools: [
      { name: 'Read', target: 'a.ts', status: 'ok' },
      { name: 'Bash', target: 'npm test', status: 'running' },
    ],
    count: 9,
    names: { Read: 5, Edit: 2, Bash: 2 },
    detail: true,
    ...patch,
  })

  it('도구 묶음 머리 · 진행 줄 · 상세 없는 묶음(C15)', () => {
    expect(toolSummary(tools())).toBe('도구 9회 · Read 5 · Bash 2 · Edit 2')
    expect(runningTool(tools())).toMatchObject({ name: 'Bash' })
    expect(toolSummary(tools({ detail: false, tools: [], names: {} }))).toBe('도구 실행 9회')
  })

  it('긴 답은 24줄에서 접는다', () => {
    const text = Array.from({ length: 30 }, (_, i) => `줄 ${i}`).join('\n')
    expect(foldText({ text, expanded: false })).toMatchObject({ hiddenLines: 6 })
    expect(foldText({ text, expanded: true }).hiddenLines).toBe(0)
  })

  it('마크다운 — 제목·목록·코드 블록·표·인용·가로줄 · 인라인 굵게·코드', () => {
    const blocks = markdownBlocks(['# 제목', '', '- 하나', '- 둘', '', '```ts', 'const a = 1', '```', '', '| a | b |', '| - | - |', '| 1 | 2 |', '', '> 인용', '', '---', '본문'].join('\n'))
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'list', 'code', 'table', 'quote', 'rule', 'para'])
    expect(blocks[2]).toEqual({ kind: 'code', lang: 'ts', text: 'const a = 1' })
    expect(blocks[3]).toEqual({ kind: 'table', header: ['a', 'b'], rows: [['1', '2']] })
    expect(inlineSpans('a **b** `c`')).toEqual([
      { text: 'a ', bold: false, code: false },
      { text: 'b', bold: true, code: false },
      { text: ' ', bold: false, code: false },
      { text: 'c', bold: false, code: true },
    ])
  })

  it('답 머리는 지시 뒤 첫 답에만 · 안내·질문 문구', () => {
    expect([...replyHeads([prompt(1), reply(2), reply(3), prompt(4), reply(5)])]).toEqual([2, 5])
    expect(noteView({ id: 1, kind: 'note', at: null, note: 'failed', text: null, clipped: false })).toMatchObject({ title: '실패', tone: 'alert' })
    expect(questionLine({ id: 1, kind: 'question', at: null, state: 'pending', answer: null, clipped: false, questions: [{ question: 'Q?', header: '고르기', options: [], multiSelect: null }, { question: 'R?', header: null, options: [], multiSelect: null }] })).toBe('고르기 — Q? 외 1')
  })
})
