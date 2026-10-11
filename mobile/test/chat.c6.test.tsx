// @vitest-environment happy-dom
// 대화 화면 C6 권한 대기 카드 시험 (LIFE-581 최종 관문 — 코디 답 msg_8eaea61f08e8 ①) — 실제 채널 화면(`app/channel/[id]`)과 실제 `Conversation` 을 RN·expo-router DOM 가짜로 그린다. 네이티브 실행이 아니다.
// 가짜 모듈은 `chat.r3.test.tsx` 그대로. 격리 실제 herdr 가 권한 프롬프트를 idle 로 판정해 C6 캡처가 공백이라(RESULT 「C6」), 카드 조건을 시험으로 덮는다. 제품 파일은 바꾸지 않았다.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Channel from '../app/channel/[id]'
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
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

const base: ChannelValue = {
  id: 'p',
  key: 's:p',
  status: 'live',
  kind: 'claude',
  title: 'C6 CHANNEL',
  dot: 'waiting',
  dotUnseen: 'waiting',
  depth: 0,
  origin: null,
  spawnedBy: null,
  parent: null,
  preview: { kind: 'approval', text: 'Bash · touch c6-probe.txt' },
  waiting: 'approval',
  model: 'haiku',
  timeAt: null,
  activityAt: 1,
  outcome: null,
}

function ready(channel: ChannelValue): ListSnapshot {
  const list: ChannelList = { available: true, repos: [{ id: 'r', name: 'safe-repo', tasks: [{ id: 't', name: 'safe-task', isDefault: false, channels: [channel] }] }], waiting: [] }
  return { phase: { kind: 'ready', receivedAt: 1, message: { seq: 1, epoch: 'e', at: 1, changedAt: 1, list } }, flashUntil: {}, ledgerVersion: 0, failure: null }
}
const connected: ConnState = { kind: 'connected', since: 1, lastAliveAt: 1 }
const failure: ListFailure = { reason: 'timeout', at: 1, incompatible: false }

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

async function render(channel: ChannelValue, input: { conn?: ConnState; failure?: ListFailure | null } = {}): Promise<string> {
  ctx.conn = input.conn ?? connected
  ctx.list = { ...ready(channel), failure: input.failure ?? null }
  await act(async () => root.render(<Channel />))
  return host.textContent ?? ''
}

const CARD = '맥에서 승인을 기다립니다'

describe('C6 권한 대기 카드 — 열린 세션이 approval 대기일 때만', () => {
  it('양성: approval + 도구 미리보기 → 카드 제목 · 도구 칩 · 안내', async () => {
    const text = await render(base)
    expect(text).toContain(CARD)
    expect(text).toContain('Bash · touch c6-probe.txt')
    expect(text).toContain('맥에서 승인하면 이어집니다')
  })

  it('양성: approval + 도구 모름(미리보기 none) → 카드는 뜨고 칩은 없다', async () => {
    const text = await render({ ...base, preview: { kind: 'none' } })
    expect(text).toContain(CARD)
    expect(text).not.toContain('Bash · touch c6-probe.txt')
  })

  it('음성: 대기 없음 · 질문 대기 · 닫힌 세션 · 끊김(offline) · 목록 낡음 → 카드 없음', async () => {
    const offline: ConnState = { kind: 'reconnecting', since: Date.now() - 30_000, lastConnectedAt: 1, attempt: 9, reason: 'network', offline: true }
    const seen: [string, boolean][] = []
    seen.push(['idle', (await render({ ...base, dot: 'idle', dotUnseen: 'idle', waiting: null, preview: { kind: 'none' } })).includes(CARD)])
    seen.push(['question', (await render({ ...base, waiting: 'question', preview: { kind: 'question', text: '배포할까요?' } })).includes(CARD)])
    seen.push(['closed', (await render({ ...base, status: 'closed' })).includes(CARD)])
    seen.push(['offline', (await render(base, { conn: offline })).includes(CARD)])
    seen.push(['stale', (await render(base, { failure })).includes(CARD)])
    expect(seen).toEqual([
      ['idle', false],
      ['question', false],
      ['closed', false],
      ['offline', false],
      ['stale', false],
    ])
  })
})
