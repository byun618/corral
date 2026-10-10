// @vitest-environment happy-dom
// 대화 화면 맨 아래 따라가기 시험 (LIFE-581 네이티브 n-12) — RN 을 DOM 가짜로 바꿔 실제 `Conversation` 과 실제 `ChatStore` 를 돌린다. 네이티브 스크롤·배치는 보지 않는다
// (그건 에뮬레이터 재현 회차 `raw/claude/n12/` 가 본다). 여기서는 화면이 네이티브에 무엇을 시키는지 — 임계 안이면 `maintainVisibleContentPosition` 을 끄고
// 내용 크기가 바뀔 때 맨 아래로 붙이고, 임계 밖이면 자리를 지키고(`minIndexForVisible`) 「새 메시지 ↓」 — 를 본다. 수정 전 코드(7cb34f31d)에서 실패하는 것을 음성 대조로 남겼다.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseChatMessage, type ChatItem } from '../src/core/chat'
import { ChatStore } from '../src/core/chat-store'
import type { SessionEvent } from '../src/core/connection'
import type { Channel } from '../src/core/list'
import { Conversation } from '../src/ui/Conversation'
import { FakeClock } from './fakes'

type ListProps = {
  data: ChatItem[]
  renderItem: (input: { item: ChatItem; index: number }) => ReactNode
  ListHeaderComponent: ReactNode
  ListFooterComponent: ReactNode
  onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => void
  onContentSizeChange?: (width: number, height: number) => void
  onScrollBeginDrag?: () => void
  onScrollEndDrag?: () => void
  maintainVisibleContentPosition?: { minIndexForVisible: number; autoscrollToTopThreshold?: number }
  ref?: { current: unknown }
}
const ctx = vi.hoisted(() => {
  const state: { list: ListProps | null; scrolls: { offset: number; animated?: boolean }[] } = { list: null, scrolls: [] }
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
  // React 19 — 함수 컴포넌트도 ref 를 prop 으로 받는다. 화면이 부르는 scrollToOffset 을 센다.
  FlatList: (props: ListProps) => {
    ctx.list = props
    if (props.ref !== undefined) props.ref.current = { scrollToOffset: (input: { offset: number; animated?: boolean }) => ctx.scrolls.push(input) }
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
  ctx.scrolls = []
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

// 화면의 「맨 아래」 임계(dp) — 수정 전 코드에도 같은 값으로 돌도록(음성 대조) 상수를 가져오지 않고 적는다.
const NEAR_BOTTOM = 120

const SCROLL = (y: number) => act(async () => ctx.list?.onScroll({ nativeEvent: { contentOffset: { y } } }))
const LAYOUT = () => act(async () => ctx.list?.onContentSizeChange?.(1080, 4000))

describe('n-12 맨 아래(또는 임계 안)를 보던 사람은 새 말풍선 뒤에도 맨 아래에 붙는다', () => {
  for (const y of [0, 26, 60, NEAR_BOTTOM]) {
    it(`offset ${y}dp — 지시 → 1초 뒤 답(두 프레임): 자리 고정 끔 · 내용이 자랄 때마다 맨 아래로 · 버튼 없음`, async () => {
      const t = harness()
      t.store.open('c1')
      t.frame(page([prompt(1), reply(2)]))
      await show({ store: t.store })
      if (y > 0) await SCROLL(y)
      t.frame(push([prompt(3)], 2))
      await show({ store: t.store })
      await LAYOUT()
      t.frame(push([reply(4)], 3))
      const text = await show({ store: t.store })
      await LAYOUT()
      expect(ctx.list?.maintainVisibleContentPosition).toBeUndefined()
      expect(ctx.scrolls).toEqual([{ offset: 0, animated: false }, { offset: 0, animated: false }])
      expect(text).not.toContain('새 메시지 ↓')
    })
  }

  it('같은 id 답이 자라도(블록 둘) 맨 아래로 붙는다', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2, '첫 블록')]))
    await show({ store: t.store })
    t.frame(push([reply(2, '첫 블록 둘째 블록')]))
    expect(await show({ store: t.store })).not.toContain('새 메시지 ↓')
    await LAYOUT()
    expect(ctx.scrolls).toEqual([{ offset: 0, animated: false }])
  })
})

describe('n-12 끄는 손을 이기지 않는다 — 새 꼬리 없이 크기만 바뀌면(가상화가 셀을 잼) 안 붙인다', () => {
  it('맨 아래에서 위로 끄는 중(임계 안) 크기 변화 → scrollToOffset 0회, 끈 뒤 새 답 → 1회', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
    ctx.scrolls = []
    await act(async () => ctx.list?.onScrollBeginDrag?.())
    await SCROLL(60)
    await LAYOUT()
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
    await act(async () => ctx.list?.onScrollEndDrag?.())
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
    t.frame(push([prompt(3), reply(4)], 2))
    await show({ store: t.store })
    await LAYOUT()
    await LAYOUT()
    expect(ctx.scrolls).toEqual([{ offset: 0, animated: false }])
  })

  it('끄는 중에 새 답이 와도 끄는 동안은 안 붙인다', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
    ctx.scrolls = []
    await act(async () => ctx.list?.onScrollBeginDrag?.())
    await SCROLL(30)
    t.frame(push([prompt(3), reply(4)], 2))
    await show({ store: t.store })
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
  })
})

describe('n-12 대조 — 위를 보던 사람(임계 밖)은 자리를 지키고 「새 메시지 ↓」', () => {
  it(`offset ${NEAR_BOTTOM + 1}dp — 자리 고정 켬 · 맨 아래로 안 옮김 · 새 답 뒤 버튼 · 버튼 누르면 맨 아래 · 다시 따라감`, async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await SCROLL(NEAR_BOTTOM + 1)
    t.frame(push([prompt(3), reply(4)], 2))
    const text = await show({ store: t.store })
    await LAYOUT()
    expect(ctx.list?.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 })
    expect(ctx.scrolls).toEqual([])
    expect(text).toContain('새 메시지 ↓')
    const button = Array.from(host.querySelectorAll('button')).find((node) => node.textContent?.includes('새 메시지'))
    await act(async () => button?.click())
    expect(ctx.scrolls).toEqual([{ offset: 0, animated: true }])
    expect(host.textContent).not.toContain('새 메시지 ↓')
    expect(ctx.list?.maintainVisibleContentPosition).toBeUndefined()
  })

  it('과거 페이지를 읽는 중(offset 300) 과거 페이지가 붙어도 맨 아래로 끌어내리지 않는다', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(10), reply(11)], { hasOlder: true }))
    await show({ store: t.store })
    await SCROLL(300)
    t.store.loadOlder()
    t.frame(page([prompt(1), reply(2)], { mode: 'older' }))
    await show({ store: t.store })
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
  })
})
