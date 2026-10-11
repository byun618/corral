// @vitest-environment happy-dom
// LIFE-582 최종 관문 R8-A1 — 질문 기록은 왔는데 목록 상태가 아직 작업 중(두 스냅샷이 따로 온다)일 때 질문에 쓴 글이 일반 지시(input.send)로 바뀌지 않는다.
// r8 리뷰 재현(raw/review/codex-r8-raw/question-race.test.tsx, 작업 브랜치 6021f4f4c)을 옮겨 기대를 뒤집었다. 실제 채널 화면·Conversation·Composer 를 RN DOM 가짜로 그린다. 네이티브 실행이 아니다.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Channel from '../app/channel/[id]'
import { inputStore } from '../src/runtime/input'
import type { ConnState } from '../src/core/connection'
import type { Channel as ChannelValue, ChannelList } from '../src/core/list'
import type { ChatItem, ChatQuestion } from '../src/core/chat'
import type { ListSnapshot } from '../src/core/list-store'

const ctx = vi.hoisted(() => {
  const state: { conn: ConnState; list: ListSnapshot | null; unread: boolean; markRead: ReturnType<typeof vi.fn>; edit: ((text: string) => void) | null } = {
    conn: { kind: 'loading' },
    list: null,
    unread: true,
    markRead: vi.fn(),
    edit: null,
  }
  return state
})

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }), useLocalSearchParams: () => ({ id: 'p' }) }))
vi.mock('../src/runtime/connection', () => ({
  useConnection: () => ({ conn: ctx.conn, info: { macName: '맥', serverVersion: '9.9.9' }, appVersion: '0.2.0' }),
  connection: { reconnectNow: vi.fn() },
}))
vi.mock('../src/runtime/list', () => ({
  useList: () => ctx.list,
  useCollapseVersion: () => 0,
  listStore: { isUnread: () => ctx.unread, markRead: ctx.markRead, refresh: vi.fn() },
  collapse: { isCollapsed: () => false, toggle: vi.fn() },
}))
// 대화 본문(LIFE-581)은 이 시험의 대상이 아니다 — 구독 열기/닫기만 센다. 본문 시험은 test/chat-*.test.ts(x).
const chatCtx = vi.hoisted(() => {
  const items: unknown[] = []
  return { open: vi.fn(), close: vi.fn(), items }
})
vi.mock('../src/runtime/chat', () => ({
  useChat: () => ({ channel: null, phase: { kind: 'ready' }, gen: 'g1', cursor: 1, items: chatCtx.items, hasOlder: false, loadingOlder: false, receivedAt: null, stale: null, dropped: 0, tailRev: 1 }),
  chatStore: { open: chatCtx.open, close: chatCtx.close, loadOlder: vi.fn(), retry: vi.fn() },
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
// 쓰기 저장소 — 보내기(send)·답(answer) 호출만 센다.
vi.mock('../src/runtime/input', () => ({ useInput: () => ({ entries: [] }), inputStore: { send: vi.fn(), stop: vi.fn(), answer: vi.fn(), cancel: vi.fn(), retry: vi.fn(), dismiss: vi.fn() } }))
vi.mock('react-native', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children, style }: { children: ReactNode; style?: { opacity?: number } }) => <div data-opacity={style?.opacity}>{children}</div>,
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children, style }: { children: ReactNode; style?: { opacity?: number } }) => <div data-opacity={style?.opacity}>{children}</div>,
  Pressable: ({ children, onPress, disabled, accessibilityLabel }: { children: ReactNode; onPress?: () => void; disabled?: boolean; accessibilityLabel?: string }) => (
    <button disabled={disabled} aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  TextInput: ({ placeholder, value, onChangeText }: { placeholder?: string; value?: string; onChangeText?: (text: string) => void }) => {
    ctx.edit = onChangeText ?? null
    return <textarea data-placeholder={placeholder} value={value} readOnly />
  },
  RefreshControl: () => null,
  ActivityIndicator: () => null,
  FlatList: (p: { data: { id: number }[]; renderItem: (input: { item: { id: number }; index: number }) => ReactNode; ListHeaderComponent: ReactNode; ListFooterComponent: ReactNode }) => (
    <div>
      {p.ListHeaderComponent}
      {p.data.map((item, index) => (
        <div key={item.id}>{p.renderItem({ item, index })}</div>
      ))}
      {p.ListFooterComponent}
    </div>
  ),
  Platform: { select: (value: { android: string }) => value.android },
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children, style }: { children: ReactNode; style?: { opacity?: number } }) => <div data-opacity={style?.opacity}>{children}</div> }))
// 아바타·상태 점은 받은 점을 속성으로만 드러낸다(글자 없음 — textContent 단언에 영향 없음). R3-A3 은 두 곳에 간 점을 본다.
vi.mock('../src/ui/StatusGlyph', () => ({
  Avatar: ({ dot }: { dot: string }) => <i data-avatar-dot={dot} />,
  StatusGlyph: ({ dot }: { dot: string }) => <i data-status-dot={dot} />,
}))

const base: ChannelValue = {
  id: 'p',
  key: 's:p',
  status: 'live',
  kind: 'codex',
  title: 'Q CHANNEL',
  dot: 'done',
  dotUnseen: 'done',
  depth: 0,
  origin: null,
  spawnedBy: null,
  parent: null,
  preview: { kind: 'none' },
  waiting: null,
  model: 'gpt',
  timeAt: null,
  activityAt: 1,
  outcome: null,
}
const asking: Partial<ChannelValue> = { dot: 'waiting', dotUnseen: 'waiting', waiting: 'question', preview: { kind: 'question', text: 'Pick a word' } }
const q = (patch: Partial<ChatQuestion> = {}): ChatQuestion => ({ question: 'Pick a word', header: null, options: [{ label: 'Yes', description: null }, { label: 'No', description: null }], multiSelect: false, preview: false, ...patch })
const pending = (questions: ChatQuestion[]): ChatItem => ({ id: 2, kind: 'question', at: null, call: 'call-2', digest: null, questions, state: 'pending', answer: null, clipped: false })

function ready(channel: ChannelValue): ListSnapshot {
  const list: ChannelList = { available: true, repos: [{ id: 'r', name: 'safe-repo', tasks: [{ id: 't', name: 'safe-task', isDefault: false, channels: [channel] }] }], waiting: [] }
  return { phase: { kind: 'ready', receivedAt: 1, message: { seq: 1, epoch: 'e', at: 1, changedAt: 1, list } }, flashUntil: {}, ledgerVersion: 0, failure: null }
}
const connected: ConnState = { kind: 'connected', since: 1, lastAliveAt: 1 }

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  ctx.unread = false
  vi.clearAllMocks()
  ctx.conn = connected
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(input: { channel: Partial<ChannelValue>; questions?: ChatQuestion[] }): Promise<{ text: string; placeholder: string | null; send: boolean }> {
  chatCtx.items = [{ id: 1, kind: 'reply', at: null, body: { text: 'SYNTHETIC_REPLY', clipped: null } }, pending(input.questions ?? [q()])]
  ctx.list = ready({ ...base, ...input.channel })
  await act(async () => root.render(<Channel />))
  const buttons = Array.from(host.querySelectorAll('button'), (button) => button.textContent ?? '')
  return { text: host.textContent ?? '', placeholder: host.querySelector('textarea')?.getAttribute('data-placeholder') ?? null, send: buttons.includes('보내기') }
}



const button = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('button[aria-label="보내기"]')
async function type(text: string): Promise<void> {
  await act(async () => ctx.edit?.(text))
}
async function press(): Promise<void> {
  await act(async () => button()?.click())
}
const kinds: ChannelValue['kind'][] = ['claude', 'grok', 'codex']

describe('R8-A1 — 질문 기록 대기 + 목록 아직 작업 중: 보내기 잠금, 일반 지시로 바뀌지 않음', () => {
  for (const kind of kinds) {
    it(`${kind}: 작업 중 불일치 → send 0 · answer 0, 보내기 잠김 · 「질문을 확인하는 중…」`, async () => {
      const view = await render({ channel: { kind, dot: 'working', waiting: null } })
      await type('answer intended for question')
      expect(button()?.disabled).toBe(true)
      await press()
      expect(inputStore.send).not.toHaveBeenCalled()
      expect(inputStore.answer).not.toHaveBeenCalled()
      expect(view.placeholder).toBe('선택지 밖 답을 직접 쓰기')
      expect(host.textContent).toContain('질문을 확인하는 중…')
    })
    it(`${kind}: 목록이 waiting:question 으로 따라오면 같은 글이 답으로 1회`, async () => {
      await render({ channel: { kind, dot: 'working', waiting: null } })
      await type('answer intended for question')
      await render({ channel: { ...asking, kind } })
      expect(host.querySelector('textarea')?.value).toBe('answer intended for question')
      await press()
      expect(inputStore.answer).toHaveBeenCalledOnce()
      expect(inputStore.send).not.toHaveBeenCalled()
    })
    it(`${kind}: 상태가 idle/done(턴이 끝남, D10)일 때만 일반 지시로 — send 1 · answer 0`, async () => {
      await render({ channel: { kind, dot: 'done', waiting: null } })
      await type('answer as instruction')
      await press()
      expect(inputStore.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'answer as instruction' }))
      expect(inputStore.answer).not.toHaveBeenCalled()
    })
  }
  it('쓴 답 초안은 목록이 잠깐 뒤처져도 남고, 그동안 보내지지 않는다', async () => {
    await render({ channel: { ...asking, kind: 'claude' } })
    await type('existing answer draft')
    await render({ channel: { kind: 'claude', dot: 'working', waiting: null } })
    expect(host.querySelector('textarea')?.value).toBe('existing answer draft')
    await press()
    expect(inputStore.send).not.toHaveBeenCalled()
    expect(inputStore.answer).not.toHaveBeenCalled()
  })
})

it('R2-A8 — 실제 질문 대기의 답 초안은 재연결을 넘어 남고 자동 전송 0', async () => {
  await render({ channel: { ...asking, kind: 'claude' } })
  await type('reconnection answer draft')
  ctx.conn = { kind: 'reconnecting', attempt: 1, since: 1, lastConnectedAt: 1, reason: 'network', offline: false }
  await act(async () => root.render(<Channel />))
  expect(host.querySelector('textarea')?.value).toBe('reconnection answer draft')
  expect(button()?.disabled).toBe(true)
  expect(inputStore.send).not.toHaveBeenCalled()
  expect(inputStore.answer).not.toHaveBeenCalled()
  ctx.conn = connected
  await act(async () => root.render(<Channel />))
  expect(host.querySelector('textarea')?.value).toBe('reconnection answer draft')
  expect(host.querySelector('textarea')?.getAttribute('data-placeholder')).toBe('선택지 밖 답을 직접 쓰기')
  await press()
  expect(inputStore.answer).toHaveBeenCalledOnce()
  expect(inputStore.send).not.toHaveBeenCalled()
})
