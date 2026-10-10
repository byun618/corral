// @vitest-environment happy-dom
// 대화 상태·화면 리뷰 r2 지적 시험 (LIFE-581 R2-A4 앱 쪽 · R2-A6) — 수정 전 코드(db07e600d)에서 실패하는 것을 음성 대조로 남겼다(raw/claude/r2).
// RN 을 DOM 가짜로 바꿔 실제 `Conversation` 과 실제 `ChatStore` 를 돌린다 — View 의 배경색은 `data-bg` 로 남겨 읽는다.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseChatMessage, type ChatItem } from '../src/core/chat'
import { ChatStore } from '../src/core/chat-store'
import { bodyState } from '../src/core/chat-view'
import type { SessionEvent } from '../src/core/connection'
import type { Channel } from '../src/core/list'
import { color } from '../src/ui/tokens'
import { Conversation } from '../src/ui/Conversation'
import { FakeClock } from './fakes'

type ListProps = { data: ChatItem[]; renderItem: (input: { item: ChatItem; index: number }) => ReactNode; ListHeaderComponent: ReactNode; ListFooterComponent: ReactNode }
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('../src/ui/StatusGlyph', () => ({ Avatar: () => null }))
vi.mock('react-native', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children, style }: { children: ReactNode; style?: { backgroundColor?: string } }) => <div data-bg={style?.backgroundColor}>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children: ReactNode; onPress?: () => void }) => <button onClick={onPress}>{children}</button>,
  ActivityIndicator: () => null,
  Platform: { select: (value: { android: string }) => value.android },
  FlatList: (props: ListProps) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.map((item, index) => (
        <div key={item.id}>{props.renderItem({ item, index })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  ),
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

function harness() {
  const clock = new FakeClock()
  const listeners: ((event: SessionEvent) => void)[] = []
  const store = new ChatStore({
    connection: { onSession: (listener) => { listeners.push(listener); return () => {} }, liveAttempt: () => 1, send: () => true, clockSample: () => null },
    now: () => clock.now(),
    timer: clock,
  })
  const frame = (value: Record<string, unknown>): void => {
    const message = parseChatMessage(value)
    for (const listener of listeners) listener(message === null ? { kind: 'chat_invalid', attempt: 1 } : { kind: 'chat', attempt: 1, message })
  }
  return { store, frame }
}
const page = (items: unknown[]) => ({ type: 'chat.page', channel: 'c1', gen: 'g1', cursor: 1, mode: 'reset', hasOlder: false, at: 1, writtenAt: 1, items })
const reply = (id: number, text: string) => ({ id, kind: 'reply', at: 0, body: { text, clipped: null } })

async function show(store: ChatStore): Promise<string> {
  await act(async () => root.render(<Conversation channel={channel} chat={store.getSnapshot()} unknown={false} dim={false} onOlder={() => {}} onRetry={() => {}} />))
  return host.textContent ?? ''
}

describe('R2-A4 일시 부재(`retrying`) — 본문을 든 채 기다리고, 회복 페이지가 오면 그대로 이어진다', () => {
  it('받은 본문이 있으면 화면은 본문 + 「다시 찾는 중」 띠 · 회복 reset 이 오면 띠가 사라진다', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([reply(1, '옛 답')]))
    t.frame({ type: 'chat.unavailable', channel: 'c1', reason: 'no_file', retrying: true })
    expect(t.store.getSnapshot().phase.kind).toBe('ready')
    expect(t.store.getSnapshot().stale).toBe('waiting')
    const text = await show(t.store)
    expect(text).toContain('옛 답')
    expect(text).toContain('다시 찾는 중')
    t.frame({ ...page([reply(10, '새 답')]), gen: 'g2' })
    expect(t.store.getSnapshot().stale).toBeNull()
    expect(await show(t.store)).toContain('새 답')
  })

  it('본문이 없으면 사유 화면 — 버튼 대신 「자동으로 이어집니다」 · 회복 페이지가 오면 ready · 끝난 부재는 예전대로(양성 대조)', () => {
    const t = harness()
    t.store.open('c1')
    t.frame({ type: 'chat.unavailable', channel: 'c1', reason: 'no_file', retrying: true })
    expect(bodyState({ phase: t.store.getSnapshot().phase, count: 0 })).toMatchObject({ kind: 'failed', detail: '맥이 찾으면 자동으로 이어집니다', retry: false })
    t.frame(page([reply(1, '답')]))
    expect(t.store.getSnapshot().phase.kind).toBe('ready')
    const gone = harness()
    gone.store.open('c1')
    gone.frame({ type: 'chat.unavailable', channel: 'c1', reason: 'not_listed', retrying: false })
    expect(bodyState({ phase: gone.store.getSnapshot().phase, count: 0 })).toMatchObject({ kind: 'failed', title: '이 세션은 지금 목록에 없습니다' })
  })
})

describe('R2-A6 도구·질문 카드 배경 = 확정 토큰 `--bg-window`(앱 `color.window`)', () => {
  it('#121212 를 쓰지 않는다 — 도구 묶음 · 질문 카드', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([
      { id: 1, kind: 'tools', at: 0, tools: [{ name: 'Bash', target: 'ls', status: 'ok' }], count: 1, names: { Bash: 1 }, detail: true },
      { id: 2, kind: 'question', at: 0, questions: [{ question: '고를까요?', header: null, options: [{ label: '예', description: null }], multiSelect: false }], state: 'pending', answer: null, clipped: false },
    ]))
    await show(t.store)
    const backgrounds = Array.from(host.querySelectorAll('[data-bg]'), (node) => node.getAttribute('data-bg'))
    expect(backgrounds).not.toContain('#121212')
    expect(backgrounds.filter((value) => value === color.window).length).toBeGreaterThanOrEqual(2)
  })
})
