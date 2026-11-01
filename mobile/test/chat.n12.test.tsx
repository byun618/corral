// @vitest-environment happy-dom
// 대화 화면 맨 아래 따라가기 시험 (LIFE-581 네이티브 n-12) — RN 을 DOM 가짜로 바꿔 실제 `Conversation` 과 실제 `ChatStore` 를 돌린다. 네이티브 스크롤·배치는 보지 않는다
// (그건 에뮬레이터 재현 회차 `raw/claude/n12/` 가 본다). 여기서는 화면이 네이티브에 무엇을 시키는지 — 임계 안이면 `maintainVisibleContentPosition` 을 끄고
// 내용 크기가 바뀔 때 맨 아래로 붙이고, 임계 밖이면 자리를 지키고(`minIndexForVisible`) 「새 메시지 ↓」 — 를 본다. 수정 전 코드(7cb34f31d)에서 실패하는 것을 음성 대조로 남겼다.
// r5 R5-A1 절은 손가락 제스처(끌기 → 놓음 → 관성) 중 들어온 새 답의 결정 — `f6bff1f48` 에서 실패하는 것을 음성 대조로 남겼다.
// r6 절은 놓은 뒤 유예(fake timer — `RELEASE_MS` 0 변이에서 실패)와 목록이 빠졌다 붙을 때의 제스처 정리(`e9cd6120f` 에서 실패).
import { act, isValidElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseChatMessage, type ChatItem } from '../src/core/chat'
import { ChatStore } from '../src/core/chat-store'
import type { SessionEvent } from '../src/core/connection'
import type { Channel } from '../src/core/list'
import { Conversation } from '../src/ui/Conversation'
import { FakeClock } from './fakes'

type ScrollEvent = { nativeEvent: { contentOffset: { y: number } } }
type TailLayoutEvent = { nativeEvent: { layout: { height: number } } }
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
  // `tailLayout` = 꼬리 셀(index 0)을 감싼 View 의 onLayout (LIFE-595 r1) — 시험이 네이티브 레이아웃 도착을 손으로 준다.
  const state: { list: ListProps | null; scrolls: { offset: number; animated?: boolean }[]; tailLayout: ((event: TailLayoutEvent) => void) | undefined; otherLayouts: number } = { list: null, scrolls: [], tailLayout: undefined, otherLayouts: 0 }
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
        {props.data.map((item, index) => {
          const cell = props.renderItem({ item, index })
          const onLayout = isValidElement<{ onLayout?: (event: TailLayoutEvent) => void }>(cell) ? cell.props.onLayout : undefined
          if (index === 0) ctx.tailLayout = onLayout
          // 꼬리 아닌 셀이 레이아웃을 들으면 오래된 셀의 측정이 `laid` 를 세운다(r3 N14) — 센다.
          else if (onLayout !== undefined) ctx.otherLayouts += 1
          return <div key={item.id}>{cell}</div>
        })}
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
  ctx.otherLayouts = 0
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

describe('r6 R6-A2 놓은 뒤 유예(100 ms) — 유예 중간엔 안 정하고, 관성이 오면 관성 종료에서 정한다 (fake timer)', () => {
  const pendingDuringDrag = async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
    ctx.scrolls = []
    await BEGIN()
    t.frame(push([prompt(3), reply(4)], 2))
    await show({ store: t.store })
    await LAYOUT()
    await SCROLL(59)
  }
  const ADVANCE = (ms: number) => act(async () => { vi.advanceTimersByTime(ms) })
  afterEach(() => { vi.useRealTimers() })

  it('ⓓ 놓음 → 99 ms(관성 시작 전) scroll 0회 → 관성 시작 → 500 ms 지나도 0회 → 관성 종료(59dp) → 맨 아래로 1회', async () => {
    await pendingDuringDrag()
    vi.useFakeTimers()
    await END(59)
    await ADVANCE(99)
    expect(ctx.scrolls).toEqual([])
    await MOMENTUM()
    await ADVANCE(500)
    expect(ctx.scrolls).toEqual([])
    await MOMENTUM_END(59)
    expect(ctx.scrolls).toEqual([{ offset: 0, animated: true }])
  })

  it('ⓓ′ 놓음 → 관성 없음 → 99 ms 엔 0회 · 100 ms 에 맨 아래로 1회', async () => {
    await pendingDuringDrag()
    vi.useFakeTimers()
    await END(59)
    await ADVANCE(99)
    expect(ctx.scrolls).toEqual([])
    await ADVANCE(1)
    expect(ctx.scrolls).toEqual([{ offset: 0, animated: true }])
  })
})

describe('r6 R6-A1 목록이 빠지면(불러오는 중·실패) 그 목록의 제스처도 끝난다 — 다시 붙은 목록은 새 답을 따라간다', () => {
  const opened = async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
    return t
  }
  // 읽기 실패(`unreadable, retrying:false`) → 실패 화면(목록 빠짐) → 재시도 → 불러오는 중 → 새 첫 페이지(같은 Conversation)
  const removeAndReturn = async (t: ReturnType<typeof harness>) => {
    t.frame({ type: 'chat.unavailable', channel: 'c1', reason: 'unreadable', retrying: false, at: 3 })
    expect(await show({ store: t.store })).toContain('다시 시도')
    expect(ctx.list).toBeNull()
    t.store.retry()
    await show({ store: t.store })
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
  }
  beforeEach(() => { ctx.list = null })
  // `ctx.list = null` 뒤에도 다시 그린 목록의 props 를 읽는다(대입으로 좁혀진 타입을 피한다)
  const listNow = (): ListProps | null => ctx.list

  it('ⓐ 관성 중 목록 빠짐(관성 종료 안 옴) → 복귀 → 새 답 → 추가 제스처 없이 맨 아래로 · 버튼 없음', async () => {
    const t = await opened()
    await BEGIN()
    await SCROLL(300)
    await END(300)
    await MOMENTUM()
    ctx.list = null
    await removeAndReturn(t)
    ctx.scrolls = []
    t.frame(push([reply(3)], 2))
    const text = await show({ store: t.store })
    await LAYOUT()
    expect(ctx.scrolls).toEqual([{ offset: 0, animated: false }])
    expect(text).not.toContain('새 메시지 ↓')
    expect(listNow()?.maintainVisibleContentPosition).toBeUndefined()
  })

  it('ⓑ 복귀 뒤 두 번째 답도(110dp 에 있어도 — 임계 안) 맨 아래로', async () => {
    const t = await opened()
    await BEGIN()
    await SCROLL(300)
    await END(300)
    await MOMENTUM()
    ctx.list = null
    await removeAndReturn(t)
    t.frame(push([reply(3)], 2))
    await show({ store: t.store })
    await LAYOUT()
    await SCROLL(110)
    ctx.scrolls = []
    t.frame(push([reply(4)], 3))
    expect(await show({ store: t.store })).not.toContain('새 메시지 ↓')
    await LAYOUT()
    expect(ctx.scrolls).toEqual([{ offset: 0, animated: false }])
  })

  it('ⓑ′ 놓은 직후(유예 중) 목록 빠짐 → 옛 목록의 놓음 타이머가 새 목록을 움직이지 않는다', async () => {
    const t = await opened()
    await BEGIN()
    await SCROLL(60)
    t.frame(push([prompt(3), reply(4)], 2))
    await show({ store: t.store })
    await END(60)
    ctx.list = null
    await removeAndReturn(t)
    ctx.scrolls = []
    await RELEASE()
    expect(ctx.scrolls).toEqual([])
  })

  for (const keep of ['stale', 'resume'] as const) {
    it(`ⓒ 목록을 남기는 ${keep} 중 관성은 그대로 — 관성 동안 강제 스크롤 없음, 관성 종료(60dp)에서 맨 아래로`, async () => {
      const t = await opened()
      ctx.scrolls = []
      await BEGIN()
      await SCROLL(60)
      await END(60)
      await MOMENTUM()
      t.reconnect()
      if (keep === 'stale') {
        t.emit({ kind: 'chat_invalid', attempt: t.attempt() })
        await show({ store: t.store })
        expect(t.store.getSnapshot().stale).toBe('invalid')
        t.reconnect()
      }
      t.frame(page([prompt(1), reply(2), prompt(3), reply(4)], { mode: 'resume', cursor: 2 }))
      await show({ store: t.store })
      expect(ctx.list).not.toBeNull()
      await LAYOUT()
      expect(ctx.scrolls).toEqual([])
      await MOMENTUM_END(60)
      expect(ctx.scrolls).toEqual([{ offset: 0, animated: true }])
    })
  }
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

// LIFE-595 — 드래그 시작이 아직 레이아웃되지 않은 꼬리 변경의 보류를 지우던 경합(r6 P10·H1). 판별 신호 = 꼬리 셀(index 0) 자신의 레이아웃(`TAIL`, r1 R1-2).
// 목록 크기 변화(`LAYOUT`)는 끄는 중 가상화 측정에도 와서 신호가 아니다. 두 레이아웃과 끌기 시작의 순서는 RN 이 보장하지 않아 순서를 바꾼 짝을 둔다.
// base `a7fc8b2a` 에서 C2 절이 실패하는 것을 음성 대조로 남겼다(corral-specs LIFE-595-stick-bottom/raw/claude). C3 절은 base 와 수정본 둘 다 통과해야 한다.
const TAIL = () => act(async () => ctx.tailLayout?.({ nativeEvent: { layout: { height: 300 } } }))
const SECRET = '사용자내용-표지-595'
/** 따라가는 중(맨 아래) 새 답이 렌더됐지만 레이아웃은 아직 — 그다음 끌기 시작. */
const tailThenBegin = async () => {
  const t = harness()
  t.store.open('c1')
  t.frame(page([prompt(1), reply(2)]))
  await show({ store: t.store })
  await LAYOUT()
  ctx.scrolls = []
  t.frame(push([prompt(3, SECRET), reply(4, `${SECRET}\n끝 줄`)], 2))
  await show({ store: t.store })
  await BEGIN()
  return t
}
/** 접힌 답의 숨은 줄 — 꼬리 변경이지만 꼬리 셀 레이아웃이 안 온다(A-F5-fold). */
const foldThenBegin = async () => {
  const t = harness()
  t.store.open('c1')
  t.frame(page([prompt(1), reply(2, '접힌 답')]))
  await show({ store: t.store })
  await LAYOUT()
  ctx.scrolls = []
  t.frame(push([reply(2, '접힌 답 숨은 줄')]))
  await show({ store: t.store })
  await BEGIN()
  return t
}
const noButton = () => expect(host.textContent).not.toContain('새 메시지 ↓')
const FOLLOWED = [{ offset: 0, animated: true }]

describe('LIFE-595 C2 끌기 시작보다 늦게 온 새 답의 레이아웃도 놓을 때(또는 놓은 뒤 도착할 때) 정한다', () => {
  it('ⓐ 유예 경로 — 꼬리 변경 → 끌기 → 늦은 레이아웃(꼬리·목록) → 53dp 에서 놓음 → 관성 없음 → 맨 아래로 1회 · 버튼 없음', async () => {
    await tailThenBegin()
    await SCROLL(53)
    await TAIL()
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
    await END(53)
    await RELEASE()
    expect(ctx.scrolls).toEqual(FOLLOWED)
    noButton()
  })

  it('ⓑ 관성 경로 — 꼬리 변경 → 끌기 → 늦은 레이아웃 → 53dp 에서 놓음 → 관성 → 관성 종료(53dp) → 맨 아래로 1회 · 버튼 없음', async () => {
    await tailThenBegin()
    await SCROLL(53)
    await LAYOUT()
    await TAIL()
    await END(53)
    await MOMENTUM()
    await RELEASE()
    expect(ctx.scrolls).toEqual([])
    await MOMENTUM_END(53)
    expect(ctx.scrolls).toEqual(FOLLOWED)
    noButton()
  })

  it(`ⓒ 끄는 중 임계 밖(${NEAR_BOTTOM + 80}dp)으로 떠난 뒤 늦은 레이아웃 → 놓음 → 자리 유지 · 「새 메시지 ↓」`, async () => {
    await tailThenBegin()
    await SCROLL(NEAR_BOTTOM + 80)
    await TAIL()
    await LAYOUT()
    await END(NEAR_BOTTOM + 80)
    await RELEASE()
    expect(ctx.scrolls).toEqual([])
    expect(host.textContent).toContain('새 메시지 ↓')
  })

  it('ⓓ (나) 유예 경로 — 늦은 꼬리 레이아웃이 settle(100 ms) 뒤에 와도 53dp 면 그때 맨 아래로 · 버튼 없음 (R1-1)', async () => {
    await tailThenBegin()
    await SCROLL(53)
    await END(53)
    await RELEASE()
    expect(ctx.scrolls).toEqual([])
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
    await TAIL()
    expect(ctx.scrolls).toEqual(FOLLOWED)
    noButton()
  })

  it('ⓔ (나) 관성 경로 — 늦은 꼬리 레이아웃이 관성 종료 뒤에 와도 53dp 면 그때 맨 아래로 (R1-1)', async () => {
    await tailThenBegin()
    await SCROLL(53)
    await END(53)
    await MOMENTUM()
    await MOMENTUM_END(53)
    expect(ctx.scrolls).toEqual([])
    await TAIL()
    await LAYOUT()
    expect(ctx.scrolls).toEqual(FOLLOWED)
    noButton()
  })

  it(`ⓕ (나) 임계 밖(${NEAR_BOTTOM + 80}dp)에서 놓은 뒤 늦은 꼬리 레이아웃 → 자리 유지 · 「새 메시지 ↓」`, async () => {
    await tailThenBegin()
    await SCROLL(NEAR_BOTTOM + 80)
    await END(NEAR_BOTTOM + 80)
    await RELEASE()
    noButton()
    await TAIL()
    expect(ctx.scrolls).toEqual([])
    expect(host.textContent).toContain('새 메시지 ↓')
  })
})

describe('LIFE-595 C2 순서 짝 — 꼬리 레이아웃·목록 크기 변화·끌기 시작의 순서를 바꿔도 같은 결정', () => {
  it('꼬리 레이아웃 → 끌기 시작 → 목록 크기 변화 → 53dp 놓음 → 맨 아래로 1회', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
    ctx.scrolls = []
    t.frame(push([prompt(3), reply(4)], 2))
    await show({ store: t.store })
    await TAIL()
    await BEGIN()
    await SCROLL(53)
    await LAYOUT()
    await END(53)
    await RELEASE()
    expect(ctx.scrolls).toEqual(FOLLOWED)
  })

  for (const order of ['tail-first', 'size-first'] as const) {
    it(`제스처 없음 — ${order === 'tail-first' ? '꼬리 레이아웃 → 목록 크기' : '목록 크기 → 꼬리 레이아웃'} → 맨 아래로 1회(겹쳐 두 번 안 붙음)`, async () => {
      const t = harness()
      t.store.open('c1')
      t.frame(page([prompt(1), reply(2)]))
      await show({ store: t.store })
      await LAYOUT()
      ctx.scrolls = []
      t.frame(push([prompt(3), reply(4)], 2))
      await show({ store: t.store })
      if (order === 'tail-first') await TAIL()
      await LAYOUT()
      if (order === 'size-first') await TAIL()
      expect(ctx.scrolls).toEqual([{ offset: 0, animated: false }])
    })
  }
})

describe('LIFE-595 R1-4 리뷰어 순서 ①~⑤ (P1·P2·P6·P4·P7)', () => {
  it('① P1 — 놓은 뒤 유예 구간(settle 전)에 늦은 꼬리 레이아웃 → 유예 끝에 맨 아래로', async () => {
    await tailThenBegin()
    await SCROLL(53)
    await END(53)
    await TAIL()
    expect(ctx.scrolls).toEqual([])
    await RELEASE()
    expect(ctx.scrolls).toEqual(FOLLOWED)
  })

  it('② P2 — 관성 구간에 늦은 꼬리 레이아웃 → 관성 동안 안 움직임 → 관성 종료에 맨 아래로', async () => {
    await tailThenBegin()
    await SCROLL(53)
    await END(53)
    await MOMENTUM()
    await TAIL()
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
    await MOMENTUM_END(53)
    expect(ctx.scrolls).toEqual(FOLLOWED)
  })

  it('③ P6 — 놓은 직후 다시 잡음 → 늦은 꼬리 레이아웃 → 다시 놓음(53dp) → 맨 아래로 1회', async () => {
    await tailThenBegin()
    await SCROLL(40)
    await END(40)
    await BEGIN()
    await TAIL()
    await SCROLL(53)
    await END(53)
    await RELEASE()
    expect(ctx.scrolls).toEqual(FOLLOWED)
  })

  it('④ P4 — 끄는 중 임계 밖으로 나갔다 안으로 돌아와 늦은 꼬리 레이아웃 → 놓음(60dp) → 맨 아래로 · 버튼 없음', async () => {
    await tailThenBegin()
    await SCROLL(NEAR_BOTTOM + 80)
    await SCROLL(60)
    await TAIL()
    await END(60)
    await RELEASE()
    expect(ctx.scrolls).toEqual(FOLLOWED)
    noButton()
  })

  it('⑤ P7 — 끄는 중 꼬리 변경 여러 번(레이아웃 없이도) → 놓음(53dp) → 맨 아래로 1회 (M7 이 지키는 것)', async () => {
    const t = await tailThenBegin()
    await SCROLL(53)
    t.frame(push([reply(4, '자란 답 1')], 3))
    await show({ store: t.store })
    t.frame(push([reply(4, '자란 답 2')], 4))
    await show({ store: t.store })
    await END(53)
    await RELEASE()
    expect(ctx.scrolls).toEqual(FOLLOWED)
  })

  it('X9 가 지키는 것 — 끄는 중 임계 밖(onScroll 200dp)에서 늦은 꼬리 레이아웃 → 놓은 자리(END)는 53dp(마지막 onScroll 뒤 throttle 사이) → 맨 아래로 · 버튼 없음', async () => {
    await tailThenBegin()
    await SCROLL(NEAR_BOTTOM + 80)
    await TAIL()
    await END(53)
    await RELEASE()
    expect(ctx.scrolls).toEqual(FOLLOWED)
    noButton()
  })

  it('M6 이 지키는 것 — 임계 안(53dp)에서 끄는 중 늦은 꼬리 레이아웃: 끄는 동안 버튼·자리 고정을 켜지 않는다', async () => {
    await tailThenBegin()
    await SCROLL(53)
    await TAIL()
    noButton()
    expect(ctx.list?.maintainVisibleContentPosition).toBeUndefined()
  })
})

describe('LIFE-595 C3 크기 변화 없는 꼬리 변경(A-F5-fold)은 끌어 놓아도 도로 끌어내리지 않는다 — 끄는 중 무관한 크기 변화가 와도 (R1-2)', () => {
  it('ⓐ 유예 경로 — 60dp 에서 놓음 → scroll 0회', async () => {
    await foldThenBegin()
    await SCROLL(60)
    await END(60)
    await RELEASE()
    expect(ctx.scrolls).toEqual([])
  })

  it('ⓑ 관성 경로 — 60dp 에서 놓음 → 관성 종료 → scroll 0회', async () => {
    await foldThenBegin()
    await SCROLL(60)
    await END(60)
    await MOMENTUM()
    await MOMENTUM_END(60)
    expect(ctx.scrolls).toEqual([])
  })

  it(`ⓒ 임계 밖(${NEAR_BOTTOM + 80}dp)으로 끌어 놓아도 숨은 변경만으로 「새 메시지 ↓」 를 띄우지 않는다`, async () => {
    await foldThenBegin()
    await SCROLL(NEAR_BOTTOM + 80)
    await END(NEAR_BOTTOM + 80)
    await RELEASE()
    expect(ctx.scrolls).toEqual([])
    noButton()
  })

  it('ⓓ (다) P8 — 끄는 중 무관한 목록 크기 변화(가상화 측정) 30번 → 60dp 놓음 → scroll 0회', async () => {
    await foldThenBegin()
    await SCROLL(60)
    for (let i = 0; i < 30; i += 1) await LAYOUT()
    await END(60)
    await RELEASE()
    expect(ctx.scrolls).toEqual([])
  })

  it(`ⓔ (다) P9 — 끄는 중 무관한 목록 크기 변화 → ${NEAR_BOTTOM + 80}dp 놓음 → 버튼 없음`, async () => {
    await foldThenBegin()
    await SCROLL(NEAR_BOTTOM + 80)
    await LAYOUT()
    await END(NEAR_BOTTOM + 80)
    await RELEASE()
    expect(ctx.scrolls).toEqual([])
    noButton()
  })

  it('ⓕ 남은 보류 — 놓은 뒤 무관한 크기 변화 · 다음 끌기(크기 변화 포함)에서도 안 끌어내림 · 다음 새 답에서는 정상으로 한 번 붙는다', async () => {
    const t = await foldThenBegin()
    await SCROLL(60)
    await END(60)
    await RELEASE()
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
    await BEGIN()
    await SCROLL(50)
    await LAYOUT()
    await LAYOUT()
    await END(50)
    await RELEASE()
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
    noButton()
    await SCROLL(0)
    t.frame(push([prompt(3), reply(4)], 3))
    await show({ store: t.store })
    await LAYOUT()
    await TAIL()
    expect(ctx.scrolls).toEqual([{ offset: 0, animated: false }])
  })
})

// 꼬리 변경 렌더 뒤 꼬리 셀 레이아웃을 기다리는 한도(화면 `LATE_LAYOUT_MS`) — 음성 대조를 위해 상수를 가져오지 않고 적는다.
const LATE_LAYOUT_MS = 1000
const TICK = (ms: number) => act(async () => { vi.advanceTimersByTime(ms) })

describe('LIFE-595 R2-1 기다리던 보류(carried)는 꼬리 변경 렌더에서 시한까지만 — 그 뒤 꼬리 셀 변화(커서·펼침·재마운트·폭)로 풀리지 않는다 (fake timer)', () => {
  afterEach(() => { vi.useRealTimers() })
  /** 꼬리 변경(렌더) → 끌기 → 놓음(관성 없음) → 유예 100 ms 로 settle(wait). 렌더 뒤 경과 = 100 ms. */
  const releasedWaiting = async (input: { fold: boolean; y: number }) => {
    vi.useFakeTimers()
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2, '접힌 답')]))
    await show({ store: t.store })
    await LAYOUT()
    ctx.scrolls = []
    t.frame(input.fold ? push([reply(2, '접힌 답 숨은 줄')]) : push([prompt(3), reply(4)], 2))
    await show({ store: t.store })
    await BEGIN()
    await SCROLL(input.y)
    await END(input.y)
    await TICK(100)
    expect(ctx.scrolls).toEqual([])
    return t
  }

  it(`경계 — 놓은 뒤 늦은 꼬리 레이아웃이 렌더 뒤 ${LATE_LAYOUT_MS} ms(시한 끝)에 오면 53dp 면 맨 아래로 (R1-1 유지)`, async () => {
    await releasedWaiting({ fold: false, y: 53 })
    await TICK(LATE_LAYOUT_MS - 100)
    await TAIL()
    expect(ctx.scrolls).toEqual(FOLLOWED)
  })

  it(`경계 — 렌더 뒤 ${LATE_LAYOUT_MS + 1} ms 에 온 꼬리 셀 레이아웃은 이 보류의 것이 아니다 → 안 끌어내림 (A4)`, async () => {
    await releasedWaiting({ fold: true, y: 60 })
    await TICK(LATE_LAYOUT_MS - 100 + 1)
    await TAIL()
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
    noButton()
  })

  it(`A5 — 임계 밖(${NEAR_BOTTOM + 80}dp)에서 놓아 기다리다 시한 뒤 꼬리 셀 재마운트 → 거짓 「새 메시지 ↓」 없음`, async () => {
    await releasedWaiting({ fold: true, y: NEAR_BOTTOM + 80 })
    await TICK(2000)
    await TAIL()
    expect(ctx.scrolls).toEqual([])
    noButton()
  })

  it('A3 — 숨은 줄 뒤 시한이 지나 끌기 시작 → 보류를 버린다 → 끄는 중 꼬리 셀 변화(커서 사라짐) → 60dp 놓음 → 안 끌어내림', async () => {
    vi.useFakeTimers()
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2, '접힌 답')]))
    await show({ store: t.store })
    await LAYOUT()
    ctx.scrolls = []
    t.frame(push([reply(2, '접힌 답 숨은 줄')]))
    await show({ store: t.store })
    await TICK(LATE_LAYOUT_MS + 1)
    await BEGIN()
    await SCROLL(60)
    await TAIL()
    await END(60)
    await TICK(100)
    expect(ctx.scrolls).toEqual([])
    noButton()
  })

  it(`경계 — 렌더 뒤 ${LATE_LAYOUT_MS} ms 에 끌기 시작하면 아직 기다린다 → 끄는 중 늦은 꼬리 레이아웃 → 53dp 놓음 → 맨 아래로 (H1 유지)`, async () => {
    vi.useFakeTimers()
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
    ctx.scrolls = []
    t.frame(push([prompt(3), reply(4)], 2))
    await show({ store: t.store })
    await TICK(LATE_LAYOUT_MS)
    await BEGIN()
    await SCROLL(53)
    await TAIL()
    await END(53)
    await TICK(100)
    expect(ctx.scrolls).toEqual(FOLLOWED)
  })

  it('두 번째 놓음 — 기다리던 보류로 시한 뒤 다시 끌어 놓으면 버린다 · 그 뒤 꼬리 셀 변화에도 안 끌어내림', async () => {
    await releasedWaiting({ fold: true, y: 60 })
    await TICK(LATE_LAYOUT_MS)
    await BEGIN()
    await SCROLL(50)
    await END(50)
    await TICK(100)
    await TAIL()
    expect(ctx.scrolls).toEqual([])
  })
})

describe('LIFE-595 R2-2 리뷰어 A7·A8 (X1·X5 가 지키는 것)', () => {
  it('A7 — 떠나 있던 중(200dp) 진짜 새 답 → 끌어 90dp 에서 놓음(꼬리 레이아웃 없이) → 맨 아래로 (따라가지 않던 보류는 carried 가 아니다)', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
    await SCROLL(NEAR_BOTTOM + 80)
    ctx.scrolls = []
    t.frame(push([prompt(3), reply(4)], 2))
    await show({ store: t.store })
    await BEGIN()
    await SCROLL(90)
    await LAYOUT()
    await END(90)
    await RELEASE()
    expect(ctx.scrolls).toEqual(FOLLOWED)
  })

  it('A8 — 진짜 답(꼬리 레이아웃 옴) 붙음 → 이어서 숨은 줄 변경 → 끌어 60dp 놓음 → 안 끌어내림 (꼬리 변경마다 laid 를 되돌린다)', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
    t.frame(push([prompt(3), reply(4, '접힌 답')], 2))
    await show({ store: t.store })
    await TAIL()
    await LAYOUT()
    expect(ctx.scrolls).toEqual([{ offset: 0, animated: false }])
    ctx.scrolls = []
    t.frame(push([reply(4, '접힌 답 숨은 줄')], 3))
    await show({ store: t.store })
    await BEGIN()
    await SCROLL(60)
    await LAYOUT()
    await END(60)
    await RELEASE()
    expect(ctx.scrolls).toEqual([])
  })
})

describe('LIFE-595 C1 진단 로그 — 고정 태그 한 줄씩, 경계·결정만, 사용자 내용 없음', () => {
  let lines: string[] = []
  beforeEach(() => {
    lines = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
  // `age`(꼬리 변경 뒤 경과 ms)는 실제 시계 시험에서 흔들려 `*` 로 바꿔 비교한다 — 값은 fake timer 시험이 따로 단언한다.
  const follow = () => lines.filter((line) => line.startsWith('[corral-follow] ')).map((line) => line.replace(/ age=-?[0-9.]+/, ' age=*'))

  it('H1 유예 경로 — begin(carried) → size skip(끄는 중 여러 번이어도 한 줄, 목록 높이 h) → tail-layout hold → end → settle follow', async () => {
    await tailThenBegin()
    await SCROLL(53)
    await LAYOUT()
    await LAYOUT()
    await LAYOUT()
    await TAIL()
    await SCROLL(54)
    await END(53)
    await RELEASE()
    expect(follow().slice(-5)).toEqual([
      '[corral-follow] begin from=none rev=2 pending=true laid=false carried=true following=true y=0 h=4000 age=* dropped=false',
      '[corral-follow] size gesture=drag carried=true laid=false h=4000 y=53 decision=skip',
      '[corral-follow] tail-layout gesture=drag rev=2 h=300 y=53 age=* decision=hold',
      '[corral-follow] end pending=true y=53',
      '[corral-follow] settle pending=true y=53 age=* via=release decision=follow',
    ])
    expect(lines.join('\n')).not.toContain(SECRET)
    expect(lines.every((line) => !line.startsWith('[corral-conn]'))).toBe(true)
  })

  it('R1-1 — settle wait → 놓은 뒤 무관한 크기 한 줄(skip) → 늦은 꼬리 레이아웃(layout) → settle via=layout', async () => {
    await tailThenBegin()
    await SCROLL(53)
    await END(53)
    await MOMENTUM()
    await MOMENTUM_END(53)
    await LAYOUT()
    await LAYOUT()
    await TAIL()
    expect(follow().slice(-6)).toEqual([
      '[corral-follow] momentum-begin from=release pending=true',
      '[corral-follow] momentum-end from=momentum pending=true y=53',
      '[corral-follow] settle pending=true carried=true y=53 age=* via=momentum decision=wait',
      '[corral-follow] size gesture=none carried=true laid=false h=4000 y=53 decision=skip',
      '[corral-follow] tail-layout gesture=none rev=2 h=300 y=53 age=* decision=layout',
      '[corral-follow] settle pending=true y=53 age=* via=layout decision=follow',
    ])
    expect(lines.join('\n')).not.toContain(SECRET)
  })

  it('R2-1 — 시한 뒤 놓으면 settle decision=drop, 시한 뒤 꼬리 셀 레이아웃은 tail-layout decision=drop', async () => {
    vi.useFakeTimers()
    await foldThenBegin()
    await SCROLL(60)
    await END(60)
    await TICK(100)
    await TICK(LATE_LAYOUT_MS)
    await TAIL()
    expect(follow().slice(-3)).toEqual([
      '[corral-follow] end pending=true y=60',
      '[corral-follow] settle pending=true carried=true y=60 age=* via=release decision=wait',
      '[corral-follow] tail-layout gesture=none rev=2 h=300 y=60 age=* decision=drop',
    ])
  })

  it('R2-1 — 관성이 시한을 넘겨 끝나면 settle decision=drop (안 끌어내림)', async () => {
    vi.useFakeTimers()
    await foldThenBegin()
    await END(60)
    await MOMENTUM()
    await TICK(LATE_LAYOUT_MS + 1)
    await MOMENTUM_END(60)
    expect(follow().at(-1)).toBe('[corral-follow] settle pending=true carried=true y=60 age=* via=momentum decision=drop')
    expect(ctx.scrolls).toEqual([])
  })

  it('R2-1 — 숨은 줄 뒤 시한이 지나 끌기 시작하면 begin 이 보류를 버린다(dropped=true)', async () => {
    vi.useFakeTimers()
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2, '접힌 답')]))
    await show({ store: t.store })
    await LAYOUT()
    t.frame(push([reply(2, '접힌 답 숨은 줄')]))
    await show({ store: t.store })
    await TICK(LATE_LAYOUT_MS + 1)
    await BEGIN()
    expect(follow().at(-1)).toBe('[corral-follow] begin from=none rev=2 pending=false laid=false carried=false following=true y=0 h=4000 age=* dropped=true')
  })

  it('size skip 은 제스처당 한 줄 — 관성 중 다시 잡으면(settle 없이) 새 제스처에서 다시 한 줄', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
    await BEGIN()
    t.frame(push([prompt(3), reply(4)], 2))
    await show({ store: t.store })
    await LAYOUT()
    await LAYOUT()
    await END(40)
    await MOMENTUM()
    await BEGIN()
    await LAYOUT()
    await LAYOUT()
    expect(follow().filter((line) => line.startsWith('[corral-follow] size '))).toEqual([
      '[corral-follow] size gesture=drag carried=false laid=false h=4000 y=0 decision=skip',
      '[corral-follow] size gesture=drag carried=false laid=false h=4000 y=40 decision=skip',
    ])
  })

  it('fold — 꼬리 레이아웃 없이 놓으면 settle decision=wait, 그 뒤 줄 없음 (「L 안 옴」과 갈리는 것은 size 의 h — 새 답이면 h 가 는다)', async () => {
    await foldThenBegin()
    await SCROLL(60)
    await LAYOUT()
    await END(60)
    await RELEASE()
    expect(follow().slice(-3)).toEqual([
      '[corral-follow] size gesture=drag carried=true laid=false h=4000 y=60 decision=skip',
      '[corral-follow] end pending=true y=60',
      '[corral-follow] settle pending=true carried=true y=60 age=* via=release decision=wait',
    ])
  })

  it('양성 대조 — 제스처 없이 답이 다섯 번 자라면 변경마다 size follow · tail-layout seen 각 한 줄 = 10줄', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await TAIL()
    await LAYOUT()
    lines = []
    for (let i = 0; i < 5; i += 1) {
      t.frame(push([reply(3, `자람 ${i}`)], 2 + i))
      await show({ store: t.store })
      await LAYOUT()
      await TAIL()
      await TAIL()
      await LAYOUT()
    }
    expect(follow()).toEqual([2, 3, 4, 5, 6].flatMap((rev) => [`[corral-follow] size gesture=none rev=${rev} h=4000 y=0 decision=follow`, `[corral-follow] tail-layout gesture=none rev=${rev} h=300 y=0 age=* decision=seen`]))
  })

  it('끄는 중 답이 20번 자라면 tail 20 + size 1 + tail-layout 1 + begin·end·settle = 25줄 · 임계 밖이면 settle button', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
    await BEGIN()
    await SCROLL(NEAR_BOTTOM + 80)
    for (let i = 0; i < 20; i += 1) {
      t.frame(push([reply(3, `자람 ${i}`)], 2 + i))
      await show({ store: t.store })
      await TAIL()
      await LAYOUT()
    }
    await END(NEAR_BOTTOM + 80)
    await RELEASE()
    const got = follow()
    expect(got).toHaveLength(25)
    expect(got.filter((line) => line.includes(' tail '))).toHaveLength(20)
    expect(got.at(-1)).toBe(`[corral-follow] settle pending=true y=${NEAR_BOTTOM + 80} age=* via=release decision=button`)
  })
})

describe('LIFE-595 낮음 수정 (r3 R3-1·R3-4)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('R3-1 B1 — 떠나 있던 중 진짜 답(레이아웃 옴) → 「새 메시지 ↓」 → 맨 아래 → 60dp 끌어 놓음 → 도로 끌어내리지 않음', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2)]))
    await show({ store: t.store })
    await LAYOUT()
    await BEGIN()
    await SCROLL(300)
    await END(300)
    await MOMENTUM()
    await MOMENTUM_END(300)
    t.frame(push([prompt(3), reply(4)], 2))
    await show({ store: t.store })
    await TAIL()
    await LAYOUT()
    const button = Array.from(host.querySelectorAll('button')).find((node) => node.textContent?.includes('새 메시지'))
    await act(async () => button?.click())
    expect(ctx.scrolls).toEqual(FOLLOWED)
    await SCROLL(0)
    ctx.scrolls = []
    await BEGIN()
    await SCROLL(60)
    await END(60)
    await RELEASE()
    expect(ctx.scrolls).toEqual([])
  })

  it('R3-4 N12 — 숨은 줄 → 끌어 1.2 s 붙잡고 놓음(settle 이 시한 밖이라 버림) → 무관한 크기 변화 → 안 끌어내림', async () => {
    vi.useFakeTimers()
    await foldThenBegin()
    await SCROLL(60)
    await TICK(1200)
    await END(60)
    await TICK(150)
    await LAYOUT()
    expect(ctx.scrolls).toEqual([])
  })

  it('R3-4 N14 — 꼬리(index 0) 셀만 레이아웃을 듣는다 · 다른 셀은 onLayout 없음', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([prompt(1), reply(2), prompt(3), reply(4)]))
    await show({ store: t.store })
    expect(ctx.tailLayout).toBeTypeOf('function')
    expect(ctx.otherLayouts).toBe(0)
  })

  for (const y of [NEAR_BOTTOM, NEAR_BOTTOM + 1]) {
    it(`R3-4 N4 — 끄는 중 새 답 → 놓은 자리 ${y}dp(관성 끝) → ${y <= NEAR_BOTTOM ? '맨 아래로' : '자리 유지 + 버튼'} (settle 경계)`, async () => {
      const t = harness()
      t.store.open('c1')
      t.frame(page([prompt(1), reply(2)]))
      await show({ store: t.store })
      await LAYOUT()
      ctx.scrolls = []
      await BEGIN()
      await SCROLL(40)
      t.frame(push([prompt(3), reply(4)], 2))
      await show({ store: t.store })
      await END(40)
      await MOMENTUM()
      await MOMENTUM_END(y)
      if (y <= NEAR_BOTTOM) {
        expect(ctx.scrolls).toEqual(FOLLOWED)
        noButton()
      } else {
        expect(ctx.scrolls).toEqual([])
        expect(host.textContent).toContain('새 메시지 ↓')
      }
    })
  }

  it('R3-2·R3-5 age·h 칸 — 꼬리 변경 렌더 뒤 경과 ms(fake timer)와 begin 의 마지막 목록 높이', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    vi.useFakeTimers()
    await tailThenBegin()
    await TICK(250)
    await TAIL()
    await SCROLL(53)
    await END(53)
    await TICK(100)
    vi.restoreAllMocks()
    expect(lines.filter((line) => line.startsWith('[corral-follow] ')).slice(-4)).toEqual([
      '[corral-follow] begin from=none rev=2 pending=true laid=false carried=true following=true y=0 h=4000 age=0 dropped=false',
      '[corral-follow] tail-layout gesture=drag rev=2 h=300 y=0 age=250 decision=hold',
      '[corral-follow] end pending=true y=53',
      '[corral-follow] settle pending=true y=53 age=350 via=release decision=follow',
    ])
  })
})
