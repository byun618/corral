// @vitest-environment happy-dom
// LIFE-582 최종 관문 Z8 C12 — 대화 기록이 없는 채널(「대화 기록 파일이 없습니다」 — 셸에서 띄운 세션 · 첫 지시 전 새 세션)에서도 보낸 지시의 상태가 보인다.
// 에뮬레이터 s38~s40: 글은 비워지고 서버는 failed/unmanaged 인데 표시가 없었다(블랙홀). 실제 채널 화면·Conversation 을 RN DOM 가짜로 그린다. 네이티브 실행이 아니다.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Channel from '../app/channel/[id]'
import type { ConnState } from '../src/core/connection'
import type { Channel as ChannelValue, ChannelList } from '../src/core/list'
import type { ListSnapshot } from '../src/core/list-store'
import { sentLine, type SentEntry } from '../src/core/input'

const ctx = vi.hoisted(() => {
  const state: { conn: ConnState; list: ListSnapshot | null; unread: boolean; markRead: ReturnType<typeof vi.fn>; edit: ((text: string) => void) | null; scrollToEnd: ReturnType<typeof vi.fn>; contentSize: (() => void) | null } = {
    conn: { kind: 'loading' },
    list: null,
    unread: true,
    markRead: vi.fn(),
    edit: null,
    scrollToEnd: vi.fn(),
    contentSize: null,
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
  const phase: { kind: string; reason?: string; retrying?: boolean } = { kind: 'unavailable', reason: 'no_file', retrying: true }
  const entries: unknown[] = []
  return { open: vi.fn(), close: vi.fn(), items, phase, entries }
})
vi.mock('../src/runtime/chat', () => ({
  useChat: () => ({ channel: null, phase: chatCtx.phase, gen: 'g1', cursor: 1, items: chatCtx.items, hasOlder: false, loadingOlder: false, receivedAt: null, stale: null, dropped: 0, tailRev: 1 }),
  chatStore: { open: chatCtx.open, close: chatCtx.close, loadOlder: vi.fn(), retry: vi.fn() },
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
// 쓰기 저장소 — 보내기(send)·답(answer) 호출만 센다.
vi.mock('../src/runtime/input', () => ({ useInput: () => ({ entries: chatCtx.entries }), inputStore: { send: vi.fn(), stop: vi.fn(), answer: vi.fn(), cancel: vi.fn(), retry: vi.fn(), dismiss: vi.fn() } }))
vi.mock('react-native', async () => {
  const { useImperativeHandle } = await vi.importActual<typeof import('react')>('react')
  // 스크롤 영역은 data-scroll 로 드러내고, 끝으로 따라가기(scrollToEnd)·내용 크기 변화(onContentSizeChange)를 잡는다(R9-A1).
  function ScrollView({ children, ref, onContentSizeChange }: { children: ReactNode; ref?: React.Ref<{ scrollToEnd: () => void }>; onContentSizeChange?: () => void }) {
    useImperativeHandle(ref, () => ({ scrollToEnd: ctx.scrollToEnd }))
    ctx.contentSize = onContentSizeChange ?? null
    return <div data-scroll="1">{children}</div>
  }
  return {
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children, style }: { children: ReactNode; style?: { opacity?: number } }) => <div data-opacity={style?.opacity}>{children}</div>,
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView,
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
  }
})
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
  title: 'NO RECORD',
  dot: 'idle',
  dotUnseen: 'idle',
  depth: 0,
  origin: null,
  spawnedBy: null,
  parent: null,
  preview: { kind: 'none' },
  waiting: null,
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
const entry = (patch: Partial<SentEntry>): SentEntry => ({ id: 'm1', channel: 'p', op: 'send', text: 'first instruction', state: 'sending', wait: null, reason: null, acked: true, sentAt: 1, at: 1, tailId: null, provisional: false, ...patch })

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  ctx.unread = false
  vi.clearAllMocks()
  ctx.conn = connected
  ctx.list = ready(base)
  chatCtx.items = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(entries: SentEntry[]): Promise<string> {
  chatCtx.entries = entries
  await act(async () => root.render(<Channel />))
  return host.textContent ?? ''
}

describe('기록 없는 채널의 보낸 지시 상태 (Z8 C12)', () => {
  it('안내는 그대로, 아래에 보낸 지시 줄 — 보내는 중', async () => {
    const text = await render([entry({ state: 'sending' })])
    expect(text).toContain('대화 기록 파일이 없습니다')
    expect(text).toContain('first instruction')
    expect(text).toContain(sentLine({ entry: entry({ state: 'sending' }), hhmm: () => '00:00', monitoring: false })?.text ?? 'MISSING')
  })
  it('실패(셸에서 띄운 세션 — unmanaged) → D1 안내 + 다시 보내기', async () => {
    const failed = entry({ state: 'failed', reason: 'unmanaged' })
    const text = await render([failed])
    expect(text).toContain('first instruction')
    expect(text).toContain('맥 셸에서 직접 띄운 세션이라 폰에서 지시할 수 없습니다')
    expect(Array.from(host.querySelectorAll('button'), (button) => button.textContent ?? '')).toContain('다시 보내기')
  })
  it('대기 중 → 취소 · 들어감(기록이 아직 안 붙음) → 들어감 줄', async () => {
    const queued = await render([entry({ state: 'queued', wait: 'turn' })])
    expect(Array.from(host.querySelectorAll('button'), (button) => button.textContent ?? '')).toContain('취소')
    expect(queued).toContain('first instruction')
    const delivered = await render([entry({ state: 'delivered' })])
    expect(delivered).toContain('들어감')
  })
  // R9-A1 — 실패 여러 개(보존 최대 20)·긴 지시(24줄)·키보드로 줄어든 높이에서도 마지막 상태·다시 보내기까지 닿는다:
  // 안내와 보낸 지시 줄이 스크롤 영역 안에 있고, 내용이 바뀌면 끝으로 따라간다. (높이 계산은 RN DOM 가짜로 못 한다 — 에뮬레이터 캡처 s69~)
  it('R9-A1 실패 12개 + 24줄 지시 — 전부 스크롤 영역 안, 마지막 다시 보내기까지 그 안에 있고 내용이 바뀌면 끝으로', async () => {
    const many = Array.from({ length: 12 }, (_, index) => entry({ id: `m${index}`, text: `failed ${index}`, state: 'failed', reason: 'unmanaged' }))
    const long = entry({ id: 'long', text: Array.from({ length: 24 }, (_, index) => `line ${index}`).join('\n'), state: 'failed', reason: 'unmanaged' })
    await render([...many, long])
    const retries = Array.from(host.querySelectorAll('button')).filter((button) => button.textContent === '다시 보내기')
    expect(retries.length).toBe(13)
    for (const button of retries) expect(button.closest('[data-scroll]')).not.toBeNull()
    expect(host.querySelector('[data-scroll]')?.textContent ?? '').toContain('대화 기록 파일이 없습니다')
    expect(host.querySelector('[data-scroll]')?.textContent ?? '').toContain('line 23')
    ctx.scrollToEnd.mockClear()
    await act(async () => ctx.contentSize?.())
    expect(ctx.scrollToEnd).toHaveBeenCalledTimes(1)
  })
  it('보낸 것이 없으면 안내만(기존 화면 그대로)', async () => {
    const text = await render([])
    expect(text).toContain('대화 기록 파일이 없습니다')
    expect(host.querySelectorAll('button').length).toBeGreaterThan(0)
    expect(text).not.toContain('first instruction')
  })
})
