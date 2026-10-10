// @vitest-environment happy-dom
// 대화 화면·상태 리뷰 r1 지적 시험 (LIFE-581 R1-A6·A7·A8·A10) — 수정 전 코드(591eb404f)에서 실패하는 것을 음성 대조로 남겼다(raw/claude/r1).
// RN 을 DOM 가짜로 바꿔 실제 `Conversation` 과 실제 `ChatStore` 를 돌린다 — 네이티브 스크롤·배치는 보지 않는다.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseChatMessage, type ChatItem } from '../src/core/chat'
import { CHAT_DEADLINE_MS, ChatStore } from '../src/core/chat-store'
import { bodyState } from '../src/core/chat-view'
import type { SessionEvent } from '../src/core/connection'
import type { Channel } from '../src/core/list'
import { Conversation } from '../src/ui/Conversation'
import { FakeClock } from './fakes'

type ListProps = { data: ChatItem[]; renderItem: (input: { item: ChatItem; index: number }) => ReactNode; ListHeaderComponent: ReactNode; ListFooterComponent: ReactNode; onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => void }
const ctx = vi.hoisted(() => {
  const state: { list: ListProps | null } = { list: null }
  return state
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('../src/ui/StatusGlyph', () => ({ Avatar: () => null }))
vi.mock('react-native', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children: ReactNode; onPress?: () => void }) => <button onClick={onPress}>{children}</button>,
  ActivityIndicator: () => null,
  Platform: { select: (value: { android: string }) => value.android },
  FlatList: (props: ListProps) => {
    ctx.list = props
    return (
      <div>
        {props.ListHeaderComponent}
        {props.data.map((item, index) => (
          <div key={item.id}>{props.renderItem({ item, index })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    )
  },
}))

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const channel: Channel = { id: 'c1', key: 's:c1', status: 'live', kind: 'claude', title: '시험', dot: 'idle', dotUnseen: 'idle', depth: 0, origin: null, spawnedBy: null, parent: null, preview: { kind: 'none' }, waiting: null, model: null, timeAt: null, activityAt: 0, outcome: null }
const prompt = (id: number, text = `지시 ${id}`): ChatItem => ({ id, kind: 'prompt', at: 0, body: { text, clipped: null } })
const reply = (id: number, text = `답 ${id}`): ChatItem => ({ id, kind: 'reply', at: 0, body: { text, clipped: null } })
const note = (id: number, kind: 'interrupted' | 'failed'): Record<string, unknown> => ({ id, kind: 'note', at: 0, note: kind, text: kind === 'failed' ? '기록의 오류 사유' : null })

/** 실제 ChatStore + 손으로 조종하는 연결(재연결 = 새 시도 번호의 `live`). */
function harness() {
  const clock = new FakeClock()
  let attempt = 1
  const listeners: ((event: SessionEvent) => void)[] = []
  const sent: Record<string, unknown>[] = []
  const store = new ChatStore({
    connection: { onSession: (listener) => { listeners.push(listener); return () => {} }, liveAttempt: () => attempt, send: (message) => { sent.push(message); return true }, clockSample: () => null },
    now: () => clock.now(),
    timer: clock,
  })
  const emit = (event: SessionEvent): void => listeners.forEach((listener) => listener(event))
  const frame = (value: Record<string, unknown>): void => {
    const message = parseChatMessage(value)
    if (message === null) emit({ kind: 'chat_invalid', attempt })
    else emit({ kind: 'chat', attempt, message })
  }
  const reconnect = (): void => {
    attempt += 1
    emit({ kind: 'live', attempt, reason: 'connect' })
  }
  return { clock, store, sent, emit, frame, reconnect, attempt: () => attempt }
}
const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'chat.page', channel: 'c1', gen: 'g1', cursor: 1, mode: 'reset', hasOlder: false, at: 1, writtenAt: 1, items, ...extra })
const push = (items: unknown[], cursor = 2) => ({ type: 'chat.items', channel: 'c1', gen: 'g1', cursor, at: 2, readAt: 2, writtenAt: 2, items })

async function show(input: { channel?: Channel; store: ChatStore }): Promise<string> {
  await act(async () => root.render(<Conversation channel={input.channel ?? channel} chat={input.store.getSnapshot()} unknown={false} dim={false} onOlder={() => {}} onRetry={() => {}} />))
  return host.textContent ?? ''
}
const count = (text: string, needle: string): number => text.split(needle).length - 1

describe('R1-A6 지금 상태가 중단·실패면 C8/C9 카드 — 최신 턴의 기록 카드와 겹치지 않게', () => {
  it('기록에 표지가 없어도 지금 점이 failed/interrupted 면 카드 한 장(실패는 지금 오류 사유)', async () => {
    for (const [dot, title] of [['failed', '실패'], ['interrupted', '중단됨']] as const) {
      const t = harness()
      t.store.open('c1')
      t.frame(page([prompt(1), reply(2)]))
      const text = await show({ store: t.store, channel: { ...channel, dot, outcome: dot, preview: { kind: 'error', text: '지금 오류 사유' } } })
      expect([dot, count(text, title)]).toEqual([dot, 1])
      if (dot === 'failed') expect(text).toContain('지금 오류 사유')
    }
  })

  it('최신 턴의 기록에 같은 카드가 있으면 상태 카드는 그리지 않는다 · 지난 턴 카드는 제자리 + 새 턴 상태 카드', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2), note(3, 'failed')]))
    const failedNow = { ...channel, dot: 'failed' as const, outcome: 'failed' as const, preview: { kind: 'error' as const, text: '지금 오류 사유' } }
    expect(count(await show({ store: t.store, channel: failedNow }), '실패')).toBe(1)
    t.frame(push([prompt(4), reply(5)], 3))
    expect(count(await show({ store: t.store, channel: failedNow }), '실패')).toBe(2)
    // 양성 대조 — 지금 점이 한가하면 상태 카드 없음(기록 카드 1장만).
    expect(count(await show({ store: t.store, channel }), '실패')).toBe(1)
  })
})

describe('R1-A7 재연결 뒤 구독 실패는 본문을 든 채 「최신 아님」 으로', () => {
  for (const cause of ['unknown_type', 'invalid', 'timeout'] as const) {
    it(`${cause} — phase 는 본문(items) 그대로 · stale 표시 · 화면에 띠`, async () => {
      const t = harness()
      t.store.open('c1')
      t.frame(page([reply(1, '받아 둔 답')]))
      t.reconnect()
      expect(t.sent.filter((message) => message.type === 'chat.subscribe')).toHaveLength(2)
      if (cause === 'unknown_type') t.emit({ kind: 'server_error', attempt: t.attempt(), code: 'unknown_type' })
      if (cause === 'invalid') t.emit({ kind: 'chat_invalid', attempt: t.attempt() })
      t.clock.advance(CHAT_DEADLINE_MS + 1)
      const snapshot = t.store.getSnapshot()
      expect(snapshot.items).toHaveLength(1)
      expect(snapshot.stale).toBe(cause === 'unknown_type' ? 'rejected' : cause)
      const text = await show({ store: t.store })
      expect(text).toContain('받아 둔 답')
      expect(text).toMatch(/새로 받지 못했습니다|보내지 않습니다|형식이 맞지 않습니다/)
      // 다음 구독이 성공하면 띠가 사라진다(양성 대조).
      t.reconnect()
      t.frame(page([reply(1, '받아 둔 답')], { mode: 'resume' }))
      expect(t.store.getSnapshot().stale).toBeNull()
    })
  }
})

describe('R1-A8 말풍선을 하나도 못 읽은 페이지는 「빈 대화」 가 아니다', () => {
  it('모르는 종류만 든 페이지 → 형식 불일치 실패 · 진짜 빈 페이지는 빈 대화(양성 대조)', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([{ id: 1, kind: 'future-kind', body: { text: 'x' } }]))
    const snapshot = t.store.getSnapshot()
    expect(bodyState({ phase: snapshot.phase, count: snapshot.items.length }).kind).toBe('failed')
    expect(await show({ store: t.store })).not.toContain('아직 대화가 없습니다')
    const empty = harness()
    empty.store.open('c1')
    empty.frame(page([]))
    const ok = empty.store.getSnapshot()
    expect(bodyState({ phase: ok.phase, count: ok.items.length }).kind).toBe('empty')
  })

  it('일부만 못 읽었으면 읽은 것은 그리고 건너뛴 수를 알린다', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), { id: 2, kind: 'future-kind' }, reply(3)]))
    expect(t.store.getSnapshot().dropped).toBe(1)
    const text = await show({ store: t.store })
    expect(text).toContain('지시 1')
    expect(text).toContain('1개를 건너뛰었습니다')
  })
})

describe('R1-A10 위에서 읽는 중 같은 말풍선이 자라면 「새 메시지 ↓」', () => {
  it('같은 id 의 답이 길어진다(Claude 블록 합치기·Grok chunk) → 버튼 · 맨 아래로 돌아오면 지운다', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2, '첫 조각')]))
    await show({ store: t.store })
    await act(async () => ctx.list?.onScroll({ nativeEvent: { contentOffset: { y: 300 } } }))
    t.frame(push([reply(2, '첫 조각 둘째 조각')]))
    expect(await show({ store: t.store })).toContain('새 메시지 ↓')
    await act(async () => ctx.list?.onScroll({ nativeEvent: { contentOffset: { y: 0 } } }))
    expect(await show({ store: t.store })).not.toContain('새 메시지 ↓')
  })

  it('과거 페이지(위쪽)를 받는 것은 새 메시지가 아니다', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(10), reply(11)], { hasOlder: true }))
    await show({ store: t.store })
    await act(async () => ctx.list?.onScroll({ nativeEvent: { contentOffset: { y: 300 } } }))
    t.store.loadOlder()
    t.frame(page([prompt(1), reply(2)], { mode: 'older' }))
    expect(await show({ store: t.store })).not.toContain('새 메시지 ↓')
  })
})
