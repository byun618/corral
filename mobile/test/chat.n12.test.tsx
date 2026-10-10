// @vitest-environment happy-dom
// 대화 화면 맨 아래 따라가기 시험 (LIFE-581 네이티브 n-12) — RN 을 DOM 가짜로 바꿔 실제 `Conversation` 과 실제 `ChatStore` 를 돌린다. 네이티브 스크롤·배치는 보지 않는다
// (그건 에뮬레이터 재현 회차 `raw/claude/n12/` 가 본다). 여기서는 화면이 네이티브에 무엇을 시키는지 — 임계 안이면 `maintainVisibleContentPosition` 을 끄고
// 내용 크기가 바뀔 때 맨 아래로 붙이고, 임계 밖이면 자리를 지키고(`minIndexForVisible`) 「새 메시지 ↓」 — 를 본다. 수정 전 코드(7cb34f31d)에서 실패하는 것을 음성 대조로 남겼다.
// r5 R5-A1 절은 손가락 제스처(끌기 → 놓음 → 관성) 중 들어온 새 답의 결정 — `f6bff1f48` 에서 실패하는 것을 음성 대조로 남겼다.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseChatMessage, type ChatItem } from '../src/core/chat'
import { ChatStore } from '../src/core/chat-store'
import type { SessionEvent } from '../src/core/connection'
import type { Channel } from '../src/core/list'
import { Conversation } from '../src/ui/Conversation'
import { FakeClock } from './fakes'

type ScrollEvent = { nativeEvent: { contentOffset: { y: number } } }
type ListProps = {
  data: ChatItem[]
  renderItem: (input: { item: ChatItem; index: number }) => ReactNode
  ListHeaderComponent: ReactNode
  ListFooterComponent: ReactNode
  onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => void
  onContentSizeChange?: (width: number, height: number) => void
  onScrollBeginDrag?: () => void
  onScrollEndDrag?: (event: ScrollEvent) => void
  onMomentumScrollBegin?: () => void
  onMomentumScrollEnd?: (event: ScrollEvent) => void
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
const at = (y: number): ScrollEvent => ({ nativeEvent: { contentOffset: { y } } })
const BEGIN = () => act(async () => ctx.list?.onScrollBeginDrag?.())
const END = (y: number) => act(async () => ctx.list?.onScrollEndDrag?.(at(y)))
const MOMENTUM = () => act(async () => ctx.list?.onMomentumScrollBegin?.())
const MOMENTUM_END = (y: number) => act(async () => ctx.list?.onMomentumScrollEnd?.(at(y)))
// 손을 뗀 뒤 관성 시작을 기다리는 유예(화면 100 ms)를 실제로 넘긴다 — 관성이 안 오는 경우(iOS 감속 없음)
const RELEASE = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 150)))

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
    await BEGIN()
    await SCROLL(60)
    await LAYOUT()
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
    await END(60)
    await RELEASE()
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
    await BEGIN()
    await SCROLL(30)
    t.frame(push([prompt(3), reply(4)], 2))
    await show({ store: t.store })
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
  })
})

describe('r5 R5-A1 제스처 중 들어온 새 답은 손을 뗀 뒤(관성이 있으면 관성이 끝난 뒤) 최신 offset 으로 정한다 — 크기 이벤트가 다시 오지 않아도', () => {
  const during = async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
    ctx.scrolls = []
    await BEGIN()
    await SCROLL(18)
    t.frame(push([prompt(3), reply(4, '새 답\n끝 줄')], 2))
    await show({ store: t.store })
    await LAYOUT()
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
    return t
  }

  it('ⓐ 임계 안(59dp)에서 놓음 · 관성 없음 → 맨 아래로(추가 크기 이벤트 없이) · 버튼 없음', async () => {
    await during()
    await SCROLL(59)
    await END(59)
    expect(ctx.scrolls).toEqual([])
    await RELEASE()
    expect(ctx.scrolls).toEqual([{ offset: 0, animated: true }])
    expect(host.textContent).not.toContain('새 메시지 ↓')
  })

  it('ⓐ′ 임계 안에서 놓음 → 관성(Android 는 늘 온다) → 관성 동안 안 움직임 → 관성 종료(임계 안) → 맨 아래로', async () => {
    await during()
    await END(59)
    await MOMENTUM()
    await RELEASE()
    expect(ctx.scrolls).toEqual([])
    await MOMENTUM_END(59)
    expect(ctx.scrolls).toEqual([{ offset: 0, animated: true }])
    expect(host.textContent).not.toContain('새 메시지 ↓')
  })

  it(`ⓑ 임계 밖(${NEAR_BOTTOM + 80}dp)에서 놓음 → 자리 유지(scroll 0회) · 「새 메시지 ↓」 · 자리 고정 켬`, async () => {
    await during()
    await SCROLL(NEAR_BOTTOM + 80)
    await END(NEAR_BOTTOM + 80)
    await RELEASE()
    expect(ctx.scrolls).toEqual([])
    expect(host.textContent).toContain('새 메시지 ↓')
    expect(ctx.list?.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 })
  })

  it('ⓑ′ 임계 밖에서 놓음 → 관성 → 관성 종료(임계 밖) → 자리 유지 · 「새 메시지 ↓」', async () => {
    await during()
    await SCROLL(NEAR_BOTTOM + 80)
    await END(NEAR_BOTTOM + 80)
    await MOMENTUM()
    await SCROLL(NEAR_BOTTOM + 200)
    await MOMENTUM_END(NEAR_BOTTOM + 200)
    expect(ctx.scrolls).toEqual([])
    expect(host.textContent).toContain('새 메시지 ↓')
  })

  for (const end of [90, NEAR_BOTTOM + 180]) {
    it(`ⓒ 놓은 뒤 관성 중에 새 답 → 관성 동안 강제 스크롤 없음 → 관성 종료 ${end}dp → ${end <= NEAR_BOTTOM ? '맨 아래로' : '자리 유지 + 버튼'}`, async () => {
      const t = harness()
      t.store.open('c1')
      t.frame(page([prompt(1), reply(2)]))
      await show({ store: t.store })
      await LAYOUT()
      ctx.scrolls = []
      await BEGIN()
      await SCROLL(40)
      await END(40)
      await MOMENTUM()
      t.frame(push([prompt(3), reply(4)], 2))
      await show({ store: t.store })
      await LAYOUT()
      await SCROLL(end)
      await LAYOUT()
      expect(ctx.scrolls).toEqual([])
      await MOMENTUM_END(end)
      if (end <= NEAR_BOTTOM) {
        expect(ctx.scrolls).toEqual([{ offset: 0, animated: true }])
        expect(host.textContent).not.toContain('새 메시지 ↓')
      } else {
        expect(ctx.scrolls).toEqual([])
        expect(host.textContent).toContain('새 메시지 ↓')
      }
    })
  }

  it('ⓓ 관성 중 다시 잡음(Android 는 이때 관성 종료를 안 낸다) → 보류는 남아 다음 놓음에서 정한다', async () => {
    await during()
    await END(50)
    await MOMENTUM()
    await BEGIN()
    await SCROLL(70)
    await END(70)
    await RELEASE()
    expect(ctx.scrolls).toEqual([{ offset: 0, animated: true }])
  })

  it('ⓕ 따라가는 중 크기 변화 없는 꼬리 변경(접힌 답 안 숨은 줄) 뒤 조금 끌고 놓아도 맨 아래로 도로 끌어내리지 않는다', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2, '접힌 답')]))
    await show({ store: t.store })
    await LAYOUT()
    ctx.scrolls = []
    t.frame(push([reply(2, '접힌 답 숨은 줄')]))
    await show({ store: t.store })
    await BEGIN()
    await SCROLL(60)
    await END(60)
    await MOMENTUM()
    await MOMENTUM_END(60)
    await RELEASE()
    expect(ctx.scrolls).toEqual([])
  })

  it('ⓔ 제스처 없이 들어온 새 답은 그대로 크기 변화에서 붙는다(놓음 처리와 겹치지 않음 — 한 번만)', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
    ctx.scrolls = []
    await SCROLL(40)
    t.frame(push([prompt(3), reply(4)], 2))
    await show({ store: t.store })
    await LAYOUT()
    await BEGIN()
    await END(10)
    await RELEASE()
    expect(ctx.scrolls).toEqual([{ offset: 0, animated: false }])
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
