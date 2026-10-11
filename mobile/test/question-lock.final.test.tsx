// @vitest-environment happy-dom
// LIFE-582 최종 관문 Z4ⓓ — 턴이 끝난 Codex 비동기 질문(기록엔 대기, 채널은 질문을 기다리지 않음)의 답 카드 잠금. 실제 채널 화면(`app/channel/[id]`)과
// 실제 `Conversation`·`Composer` 를 RN·expo-router DOM 가짜로 그린다(가짜 모듈은 `chat.c6.test.tsx` 그대로 — 대화 항목·입력창 자리표시만 바꿈). 네이티브 실행이 아니다.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Channel from '../app/channel/[id]'
import type { ConnState } from '../src/core/connection'
import type { Channel as ChannelValue, ChannelList } from '../src/core/list'
import type { ChatItem, ChatQuestion } from '../src/core/chat'
import type { ListSnapshot } from '../src/core/list-store'

const ctx = vi.hoisted(() => {
  const state: { conn: ConnState; list: ListSnapshot | null; unread: boolean; markRead: ReturnType<typeof vi.fn> } = {
    conn: { kind: 'loading' },
    list: null,
    unread: true,
    markRead: vi.fn(),
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
// 쓰기(LIFE-582) — 이 시험의 대상이 아니다. 보낸 것 없음 · 입력창은 글 없는 빈 칸.
vi.mock('../src/runtime/input', () => ({ useInput: () => ({ entries: [] }), inputStore: { send: vi.fn(), stop: vi.fn(), answer: vi.fn(), cancel: vi.fn(), retry: vi.fn(), dismiss: vi.fn() } }))
vi.mock('react-native', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children, style }: { children: ReactNode; style?: { opacity?: number } }) => <div data-opacity={style?.opacity}>{children}</div>,
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children, style }: { children: ReactNode; style?: { opacity?: number } }) => <div data-opacity={style?.opacity}>{children}</div>,
  Pressable: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  TextInput: ({ placeholder }: { placeholder?: string }) => <textarea data-placeholder={placeholder} />,
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

const ENDED = 'Codex 가 턴을 마쳤습니다 — 아래 입력창에 답을 지시로 보내 주세요'
const NOT_WAITING = '지금은 폰에서 답할 수 없는 질문입니다 — 맥에서 확인해 주세요'
const SHAPE = '맥에서 답해 주세요 — 이 질문은 폰에서 고를 수 없습니다'

describe('턴이 끝난 질문 — 채널이 질문을 기다리지 않으면 카드 잠금 (최종 관문 Z4ⓓ)', () => {
  it('Codex 턴 끝남(done) + 기록 대기 질문 → 카드 잠금 「지시로 답」 문구, 답 버튼 없음, 입력창은 일반 지시', async () => {
    const view = await render({ channel: {} })
    expect(view.text).toContain('Pick a word')
    expect(view.text).toContain(ENDED)
    expect(view.text).not.toContain(NOT_WAITING)
    expect(view.send).toBe(false)
    expect(view.placeholder).toBe('지시 보내기')
  })
  it('같은 질문인데 채널이 질문 대기 → 열림(답 버튼 · 직접 입력 자리표시)', async () => {
    const view = await render({ channel: asking })
    expect(view.text).not.toContain(ENDED)
    expect(view.send).toBe(true)
    expect(view.placeholder).toBe('선택지 밖 답을 직접 쓰기')
  })
  it('상태가 바뀌면 다시 그린다 — 한가 → 질문 대기 → 열림', async () => {
    expect((await render({ channel: {} })).send).toBe(false)
    const view = await render({ channel: asking })
    expect(view.send).toBe(true)
    expect(view.text).not.toContain(ENDED)
  })
  it('작업 중(턴이 아직 돎)은 기다리지 않음 — 「지금은 답할 수 없음」 잠금, 입력창은 큐 안내', async () => {
    const view = await render({ channel: { dot: 'working', dotUnseen: 'working' } })
    expect(view.text).toContain(NOT_WAITING)
    expect(view.text).not.toContain(ENDED)
    expect(view.placeholder).toBe('지시 보내기 — 이 턴이 끝나면 들어갑니다')
  })
  it('권한 대기 + 기록 대기 질문 → 카드 잠금, 입력창은 일반 지시로 열리지 않는다(승인 잠금)', async () => {
    const view = await render({ channel: { dot: 'waiting', dotUnseen: 'waiting', waiting: 'approval' } })
    expect(view.text).toContain(NOT_WAITING)
    expect(view.placeholder).toBe('맥에서 승인할 때까지 보낼 수 없음')
  })
  it('질문 대기 중 모양 잠금(Codex multiSelect)은 기존 문구 · 입력창도 기존 잠금', async () => {
    const view = await render({ channel: asking, questions: [q({ multiSelect: true })] })
    expect(view.text).toContain(SHAPE)
    expect(view.placeholder).toBe('맥에서 답해 주세요')
  })
  it('Claude · Grok 질문 대기 정상 경로는 그대로 열림', async () => {
    const kinds: ChannelValue['kind'][] = ['claude', 'grok']
    for (const kind of kinds) {
      const view = await render({ channel: { ...asking, kind } })
      expect(view.send).toBe(true)
      expect(view.text).not.toContain(ENDED)
      expect(view.text).not.toContain(NOT_WAITING)
      expect(view.placeholder).toBe('선택지 밖 답을 직접 쓰기')
    }
  })
})
