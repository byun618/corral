// @vitest-environment happy-dom
// LIFE-582 r11 F1 — 재연결·다시 열기 뒤 대화 창을 최근 N 개로 다시 받으면(reset · hasOlder) 첫 지시 말풍선이 창 밖으로 밀려,
// 그 지시의 「들어감 ✓」 말풍선이 대화 끝에 한 번 더 보였다(네이티브 n6 — 표시 2 ≠ 기록 1, Z6ⓕ). 실제 ChatStore + placeSent + Conversation 을 RN DOM 가짜로 돌린다.
// 네이티브 스크롤·배치는 보지 않는다.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseChatMessage, type ChatItem } from '../src/core/chat'
import { ChatStore } from '../src/core/chat-store'
import type { SessionEvent } from '../src/core/connection'
import { placeSent, type SentEntry } from '../src/core/input'
import type { Channel } from '../src/core/list'
import { Conversation } from '../src/ui/Conversation'
import { FakeClock } from './fakes'

type ListProps = { data: ChatItem[]; renderItem: (input: { item: ChatItem; index: number }) => ReactNode; ListHeaderComponent: ReactNode; ListFooterComponent: ReactNode }

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('../src/ui/StatusGlyph', () => ({ Avatar: () => null }))
vi.mock('react-native', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
const FIRST = 'n1-h1-a reply OK only'
const prompt = (id: number, text: string): Record<string, unknown> => ({ id, kind: 'prompt', at: 0, body: { text } })
const reply = (id: number): Record<string, unknown> => ({ id, kind: 'reply', at: 0, body: { text: `OK ${id}` } })
const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'chat.page', channel: 'c1', gen: 'g1', cursor: 1, mode: 'reset', hasOlder: false, at: 1, writtenAt: 1, items, ...extra })
const push = (items: unknown[]) => ({ type: 'chat.items', channel: 'c1', gen: 'g1', cursor: 2, at: 2, readAt: 2, writtenAt: 2, items })
// 기록 파일이 없을 때 보낸 첫 지시 — 대화 창이 비어 있어 tailId 는 null(채널 화면 `chat.items.at(-1)?.id ?? null`).
const first: SentEntry = { id: 'm1', channel: 'c1', op: 'send', text: FIRST, state: 'delivered', wait: null, reason: null, acked: true, sentAt: 1, at: 1, tailId: null, provisional: false }

function harness() {
  const clock = new FakeClock()
  let attempt = 1
  const listeners: ((event: SessionEvent) => void)[] = []
  const store = new ChatStore({
    connection: { onSession: (listener) => { listeners.push(listener); return () => {} }, liveAttempt: () => attempt, send: () => true, clockSample: () => null },
    now: () => clock.now(),
    timer: clock,
  })
  const emit = (event: SessionEvent): void => listeners.forEach((listener) => listener(event))
  const frame = (value: Record<string, unknown>): void => {
    const message = parseChatMessage(value)
    if (message === null) throw new Error('frame')
    emit({ kind: 'chat', attempt, message })
  }
  const reconnect = (): void => {
    attempt += 1
    emit({ kind: 'live', attempt, reason: 'connect' })
  }
  return { store, frame, reconnect }
}

async function show(input: { store: ChatStore; sent: readonly SentEntry[] }): Promise<string> {
  const chat = input.store.getSnapshot()
  const sent = placeSent({ items: chat.items, sent: input.sent, hasOlder: chat.hasOlder })
  await act(async () => root.render(<Conversation channel={channel} chat={chat} unknown={false} dim={false} onOlder={() => {}} onRetry={() => {}} sent={sent} />))
  return host.textContent ?? ''
}
const count = (text: string): number => text.split(FIRST).length - 1

describe('F1 재연결 뒤 창 밖으로 밀린 첫 지시 — 끝에 다시 그리지 않는다', () => {
  it('표시된 첫 지시 말풍선 수 = 지금 창에 받은 기록 수 (밀림 0 · 앞쪽 받으면 1)', async () => {
    const t = harness()
    t.store.open('c1')
    t.frame(page([]))
    t.frame(push([prompt(1, FIRST), reply(2)]))
    expect(count(await show({ store: t.store, sent: [first] }))).toBe(1)

    // 대화가 길어진 뒤 재연결 — 서버는 최근 40 개만 다시 보낸다(native 05:33:27 chat_page reset items 40 / index 41).
    const recent = Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? prompt(index + 2, `later ${index + 2}`) : reply(index + 2)))
    t.reconnect()
    t.frame(page(recent, { hasOlder: true }))
    const after = await show({ store: t.store, sent: [first] })
    expect(after).toContain('later 2')
    expect(count(after)).toBe(0)

    // 위로 올려 앞쪽을 받으면 기록 말풍선에 붙어 한 번만.
    t.frame({ ...page([prompt(1, FIRST)], { mode: 'older', hasOlder: false }) })
    expect(count(await show({ store: t.store, sent: [first] }))).toBe(1)
  })

  it('보낸 뒤 끝이 창 안인데 기록이 없으면 그대로 끝에 그린다 · 아직 안 들어간 것은 앞쪽이 남아도 끝에', () => {
    const items = Array.from({ length: 3 }, (_, index) => ({ id: index + 10, kind: 'reply' as const, at: 0, body: { text: `r${index}`, clipped: null } }))
    expect(placeSent({ items, sent: [{ ...first, tailId: 11 }], hasOlder: true }).trailing).toHaveLength(1)
    expect(placeSent({ items, sent: [{ ...first, tailId: 5 }], hasOlder: true }).trailing).toHaveLength(0)
    expect(placeSent({ items, sent: [{ ...first, state: 'failed', reason: 'unmanaged' }], hasOlder: true }).trailing).toHaveLength(1)
    expect(placeSent({ items, sent: [{ ...first, state: 'unconfirmed', reason: 'no_reply' }], hasOlder: true }).trailing).toHaveLength(1)
    expect(placeSent({ items, sent: [first], hasOlder: false }).trailing).toHaveLength(1)
  })
})
