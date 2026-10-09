// @vitest-environment happy-dom
// 목록·대화 자리 화면 시험 (LIFE-580 수정 r1 — R1-A4 · R1-A6 · C2 · r3 R3-A3). RN·expo-router 를 DOM 가짜로 바꾸고 실제 화면 코드를 그린다. 네이티브 실행이 아니다.
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

describe('R2-A2 대화 자리 화면도 목록 실패를 안다 — Home 과 같은 상태를 동시에', () => {
  const failures: ListFailure[] = [
    { reason: 'invalid', at: 2, incompatible: true },
    { reason: 'rejected', at: 2, incompatible: true },
    { reason: 'timeout', at: 2, incompatible: false },
  ]
  for (const failure of failures) {
    it(`${failure.reason} — Home·Channel 모두 「오래된 값」 띠(기준 시각) · Channel 상태 「확인 불가」 · 읽음 장부 그대로`, async () => {
      ctx.conn = connected
      ctx.list = ready(withChannel, failure)
      const home = await render(<Home />)
      expect(home).toContain('목록이 최신이 아닙니다 · 04:05 기준')
      const channel = await render(<Channel />)
      expect(channel).toContain('목록이 최신이 아닙니다 · 04:05 기준')
      expect(channel).toContain('확인 불가')
      expect(channel).not.toContain('한가')
      if (failure.incompatible) expect(channel).toContain('업데이트')
      expect(ctx.markRead).not.toHaveBeenCalled()
    })
  }

  it('받은 목록 없이 실패 — Channel 은 「목록에 없음」 대신 실패 안내', async () => {
    ctx.conn = connected
    ctx.list = { phase: { kind: 'waiting' }, flashUntil: {}, ledgerVersion: 0, failure: { reason: 'invalid', at: 1, incompatible: true } }
    const channel = await render(<Channel />)
    expect(channel).toContain('목록 형식이 맞지 않습니다')
    expect(channel).not.toContain('이 세션은 지금 목록에 없습니다')
  })

  it('양성 대조 — 실패가 지워지면(정상 목록) 띠 없음 · 실제 상태 · 열면 읽음', async () => {
    ctx.conn = connected
    ctx.list = ready(withChannel)
    const channel = await render(<Channel />)
    expect(channel).not.toContain('목록이 최신이 아닙니다')
    expect(channel).toContain('한가')
    expect(channel).not.toContain('확인 불가')
    expect(ctx.markRead).toHaveBeenCalledTimes(1)
  })
})

describe('R3-A3 대화 자리 머리 — 아바타 배지·별도 점·상태 글이 표시 점 하나를 같이 쓴다', () => {
  const dots = () => ({
    avatar: host.querySelector('[data-avatar-dot]')?.getAttribute('data-avatar-dot') ?? null,
    status: host.querySelector('[data-status-dot]')?.getAttribute('data-status-dot') ?? null,
  })
  const asked: ChannelValue = { ...cached, dot: 'waiting', dotUnseen: 'waiting', waiting: 'question' }
  const busy: ChannelValue = { ...cached, dot: 'working', dotUnseen: 'working' }
  const listOf = (channel: ChannelValue): ChannelList => ({ ...withChannel, repos: [{ ...withChannel.repos[0], tasks: [{ ...withChannel.repos[0].tasks[0], channels: [channel] }] }] })
  const offline: ConnState = { kind: 'reconnecting', since: 1, lastConnectedAt: 1, attempt: 1, reason: 'network', offline: true }

  for (const [name, channel] of [['질문 대기', asked], ['작업 중', busy]] as const) {
    for (const reason of ['invalid', 'rejected', 'timeout'] as const) {
      it(`캐시 ${name} + 목록 ${reason} — 아바타·점 모두 unverifiable · 「확인 불가」 · 이전 상태 글 없음`, async () => {
        ctx.conn = connected
        ctx.list = ready(listOf(channel), { reason, at: 2, incompatible: reason !== 'timeout' })
        const text = await render(<Channel />)
        expect(dots()).toEqual({ avatar: 'unverifiable', status: 'unverifiable' })
        expect(text).toContain('확인 불가')
        expect(text).not.toContain(name)
      })
    }
    it(`캐시 ${name} + 연결 끊김 — 같은 규칙`, async () => {
      ctx.conn = offline
      ctx.list = ready(listOf(channel))
      await render(<Channel />)
      expect(dots()).toEqual({ avatar: 'unverifiable', status: 'unverifiable' })
    })
    it(`양성 대조 — ${name} 정상 목록이면 아바타·점 모두 실제 점 · 상태 글 「${name}」`, async () => {
      ctx.conn = connected
      ctx.list = ready(listOf(channel))
      const text = await render(<Channel />)
      expect(dots()).toEqual({ avatar: channel.dot, status: channel.dot })
      expect(text).toContain(name)
      expect(text).not.toContain('확인 불가')
    })
  }

  it('실패 → 복구 — 같은 화면에서 실패가 지워지면 아바타·점·글이 함께 실제 상태로 돌아온다', async () => {
    ctx.conn = connected
    ctx.list = ready(listOf(asked), { reason: 'timeout', at: 2, incompatible: false })
    await render(<Channel />)
    expect(dots()).toEqual({ avatar: 'unverifiable', status: 'unverifiable' })
    ctx.list = ready(listOf(asked))
    const text = await render(<Channel />)
    expect(dots()).toEqual({ avatar: 'waiting', status: 'waiting' })
    expect(text).toContain('질문 대기')
  })
})
