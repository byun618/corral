// @vitest-environment happy-dom
// 대화 화면 본문 흐림 시험 (LIFE-581 R3-A2) — 실제 채널 화면(`app/channel/[id]`)과 실제 `Conversation` 을 RN·expo-router DOM 가짜로 그린다. 네이티브 실행이 아니다.
// 리뷰어 재현(`raw/review/codex-r3-raw/review-r3-ui.test.tsx`)의 가짜 모듈을 그대로 이어받았다. 수정 전 코드(090a396ec)에서 실패하는 것을 음성 대조로 남겼다(raw/claude/r3).
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Channel from '../app/channel/[id]'
import { bandFor, RECONNECT_GRACE_MS } from '../src/core/band'
import type { ConnState } from '../src/core/connection'
import type { Channel as ChannelValue, ChannelList } from '../src/core/list'
import type { ListFailure, ListSnapshot } from '../src/core/list-store'

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
const chatCtx = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }))
vi.mock('../src/runtime/chat', () => ({
  useChat: () => ({ channel: null, phase: { kind: 'ready' }, gen: 'g1', cursor: 1, items: [{ id: 1, kind: 'reply', at: null, body: { text: 'SYNTHETIC_REPLY', clipped: null } }], hasOlder: false, loadingOlder: false, receivedAt: null, stale: null, dropped: 0, tailRev: 1 }),
  chatStore: { open: chatCtx.open, close: chatCtx.close, loadOlder: vi.fn(), retry: vi.fn() },
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
// 쓰기(LIFE-582) — 이 시험의 대상이 아니다. 보낸 것 없음 · 입력창은 글 없는 빈 칸.
vi.mock('../src/runtime/input', () => ({ useInput: () => ({ entries: [] }), inputStore: { send: vi.fn(), stop: vi.fn(), answer: vi.fn(), cancel: vi.fn(), retry: vi.fn(), dismiss: vi.fn() } }))
vi.mock('react-native', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children, style }: { children: ReactNode; style?: { opacity?: number } }) => <div data-opacity={style?.opacity}>{children}</div>,
  ScrollView: ({ children, style }: { children: ReactNode; style?: { opacity?: number } }) => <div data-opacity={style?.opacity}>{children}</div>,
  Pressable: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  TextInput: () => <textarea />,
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

const cached: ChannelValue = {
  id: 'p',
  key: 's:p',
  status: 'live',
  kind: 'claude',
  title: 'CACHED CHANNEL',
  dot: 'idle',
  dotUnseen: 'idle',
  depth: 1,
  origin: null,
  spawnedBy: null,
  parent: { title: '코디 세션' },
  preview: { kind: 'none' },
  waiting: null,
  model: 'opus',
  timeAt: null,
  activityAt: 1,
  outcome: null,
}

function ready(list: ChannelList, failure: ListFailure | null = null): ListSnapshot {
  return { phase: { kind: 'ready', receivedAt: new Date(2026, 9, 10, 4, 5).getTime(), message: { seq: 1, epoch: 'e', at: 1, changedAt: 1, list } }, flashUntil: {}, ledgerVersion: 0, failure }
}
const withChannel: ChannelList = { available: true, repos: [{ id: 'r', name: 'safe-repo', tasks: [{ id: 't', name: 'safe-task', isDefault: false, channels: [cached] }] }], waiting: [] }
const connected: ConnState = { kind: 'connected', since: 1, lastAliveAt: 1 }

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  ctx.markRead.mockClear()
  chatCtx.open.mockClear()
  chatCtx.close.mockClear()
  ctx.unread = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(node: ReactNode): Promise<string> {
  await act(async () => root.render(node))
  return host.textContent ?? ''
}

/** 대화 본문(`Conversation` 의 바깥 View) 의 opacity — 받은 답을 품은 가장 안쪽 opacity 칸. */
function bodyOpacity(): string | null {
  const nodes = Array.from(host.querySelectorAll('[data-opacity]')).filter((node) => node.textContent?.includes('SYNTHETIC_REPLY'))
  return nodes[nodes.length - 1]?.getAttribute('data-opacity') ?? null
}

describe('R3-A2 본문 흐림은 실제 끊김(C18)에만 — 재연결 중은 유예 전·후 모두 흐리지 않는다(디자인 Q10)', () => {
  it('connected · reconnecting(3초 전) · reconnecting(3초 뒤) · offline — opacity 1·1·1·0.5, 연결 띠 유예는 그대로', async () => {
    ctx.list = ready(withChannel)
    ctx.unread = false
    const now = Date.now()
    const cases: [string, ConnState][] = [
      ['connected', connected],
      ['reconnecting-early', { kind: 'reconnecting', since: now, lastConnectedAt: 1, attempt: 1, reason: 'network', offline: false }],
      ['reconnecting-late', { kind: 'reconnecting', since: now - RECONNECT_GRACE_MS - 1000, lastConnectedAt: 1, attempt: 3, reason: 'network', offline: false }],
      ['offline', { kind: 'reconnecting', since: now - 30_000, lastConnectedAt: 1, attempt: 9, reason: 'network', offline: true }],
    ]
    const seen: [string, string | null, string, boolean][] = []
    for (const [name, conn] of cases) {
      ctx.conn = conn
      const text = await render(<Channel />)
      seen.push([name, bodyOpacity(), bandFor(conn, now).kind, text.includes('SYNTHETIC_REPLY')])
    }
    expect(seen).toEqual([
      ['connected', '1', 'none', true],
      ['reconnecting-early', '1', 'none', true],
      ['reconnecting-late', '1', 'reconnecting', true],
      ['offline', '0.5', 'offline', true],
    ])
  })
})
