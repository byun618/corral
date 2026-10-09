// @vitest-environment happy-dom
// 목록·대화 자리 화면 시험 (LIFE-580 수정 r1 — R1-A4 · R1-A6 · C2). RN·expo-router 를 DOM 가짜로 바꾸고 실제 화면 코드를 그린다. 네이티브 실행이 아니다.
// 리뷰어 재현(`raw/review/codex-r1-raw/review-ui.test.tsx`)의 모양을 이어받았다 — 같은 상태를 Home·자리 화면에 동시에 넣는다.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Channel from '../app/channel/[id]'
import Home from '../app/home'
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
vi.mock('react-native', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  RefreshControl: () => null,
  ActivityIndicator: () => null,
  Platform: { select: (value: { android: string }) => value.android },
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('../src/ui/StatusGlyph', () => ({ Avatar: () => null, StatusGlyph: () => null }))

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
const empty: ChannelList = { available: true, repos: [], waiting: [] }
const connected: ConnState = { kind: 'connected', since: 1, lastAliveAt: 1 }

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  ctx.markRead.mockClear()
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

describe('R1-A6 버전 불일치 — 목록·대화 자리 화면 둘 다 캐시를 숨긴다', () => {
  it('같은 상태(mismatch + 캐시 목록)에서 Home·Channel 모두 채널 정보 0 · 버전 안내 · 읽음 장부 그대로', async () => {
    ctx.conn = { kind: 'mismatch', at: 1, supported: [2] }
    ctx.list = ready(withChannel)
    const home = await render(<Home />)
    expect(home).not.toContain('CACHED CHANNEL')
    expect(home).toContain('버전이 맞지 않습니다')
    const channel = await render(<Channel />)
    for (const hidden of ['CACHED CHANNEL', 'safe-repo', 'safe-task', 'opus', '코디 세션']) expect(channel).not.toContain(hidden)
    expect(channel).toContain('버전이 맞지 않습니다')
    expect(ctx.markRead).not.toHaveBeenCalled()
  })

  it('양성 대조 — 연결됨이면 자리 화면이 채널 머리를 그리고 열면 읽음', async () => {
    ctx.conn = connected
    ctx.list = ready(withChannel)
    const channel = await render(<Channel />)
    expect(channel).toContain('CACHED CHANNEL')
    expect(channel).toContain('safe-repo › safe-task')
    expect(channel).not.toContain('버전이 맞지 않습니다')
    expect(ctx.markRead).toHaveBeenCalledTimes(1)
  })
})

describe('R1 C2 대화 머리 — 같은 그룹 부모도 「띄운 세션」', () => {
  it('목록 행 규칙(spawnedBy null)과 달리 머리에는 parent 가 나온다', async () => {
    ctx.conn = connected
    ctx.list = ready(withChannel)
    expect(await render(<Channel />)).toContain('opus · 띄운 세션: 코디 세션')
  })
})

describe('R1-A4 목록 실패를 「받는 중」·「세션 0」 으로 그리지 않는다', () => {
  it('받은 목록 없음 + 읽지 못함 → 업데이트 안내(받는 중 아님)', async () => {
    ctx.conn = connected
    ctx.list = { phase: { kind: 'waiting' }, flashUntil: {}, ledgerVersion: 0, failure: { reason: 'invalid', at: 1, incompatible: true } }
    const home = await render(<Home />)
    expect(home).toContain('목록 형식이 맞지 않습니다')
    expect(home).toContain('업데이트')
    expect(home).not.toContain('목록을 받는 중')
    expect(home).not.toContain('열린 AI 세션이 없습니다')
  })

  it('받은 목록 없음 + 응답 없음(timeout) → 응답 없음 안내', async () => {
    ctx.conn = connected
    ctx.list = { phase: { kind: 'waiting' }, flashUntil: {}, ledgerVersion: 0, failure: { reason: 'timeout', at: 1, incompatible: false } }
    const home = await render(<Home />)
    expect(home).toContain('목록 응답이 없습니다')
    expect(home).not.toContain('목록을 받는 중')
  })

  it('빈 목록 뒤 실패 → 「오래된 값」 띠(기준 시각) — 세션 0 을 지금 값처럼 보이지 않는다', async () => {
    ctx.conn = connected
    ctx.list = ready(empty, { reason: 'invalid', at: 2, incompatible: true })
    const home = await render(<Home />)
    expect(home).toContain('목록이 최신이 아닙니다 · 04:05 기준')
    expect(home).toContain('목록 형식이 맞지 않습니다')
  })

  it('채널 있는 목록 뒤 구독 거부 → 띠 + 이전 목록은 남되 오래된 값으로', async () => {
    ctx.conn = connected
    ctx.list = ready(withChannel, { reason: 'rejected', at: 2, incompatible: true })
    const home = await render(<Home />)
    expect(home).toContain('목록이 최신이 아닙니다')
    expect(home).toContain('맥이 목록을 보내지 않습니다')
    expect(home).toContain('CACHED CHANNEL')
  })

  it('양성 대조 — 실패 없음: 받는 중 · 세션 0 · 띠 없음', async () => {
    ctx.conn = connected
    ctx.list = { phase: { kind: 'waiting' }, flashUntil: {}, ledgerVersion: 0, failure: null }
    expect(await render(<Home />)).toContain('목록을 받는 중')
    ctx.list = ready(empty)
    const home = await render(<Home />)
    expect(home).toContain('열린 AI 세션이 없습니다')
    expect(home).not.toContain('목록이 최신이 아닙니다')
  })
})
