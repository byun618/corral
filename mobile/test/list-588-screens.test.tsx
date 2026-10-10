// @vitest-environment happy-dom
// 목록 화면 하위 묶음 머리 (LIFE-588 W3ⓒⓓ · W5) — RN·expo-router 를 DOM 가짜로 바꾸고 실제 화면 코드를 그린다(`list-screens.test.tsx` 와 같은 틀). 네이티브 실행이 아니다.
// 입력은 서버가 고정 상태 묶음으로 만든 실제 메시지(`fixtures/list-588-message.json`). happy-dom 환경은 `import.meta.url` 이 file 이 아니라 `__dirname` 으로 읽는다.
import fs from 'node:fs'
import path from 'node:path'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Channel from '../app/channel/[id]'
import Home from '../app/home'
import type { ConnState } from '../src/core/connection'
import { parseListMessage } from '../src/core/list'
import { MALFORMED, withFeatChannels } from './fixtures/list-588-malformed'
import type { ListSnapshot } from '../src/core/list-store'

const ctx = vi.hoisted(() => {
  const state: { conn: ConnState; list: ListSnapshot | null; collapsed: boolean; id: string } = { conn: { kind: 'loading' }, list: null, collapsed: false, id: 'd1' }
  return state
})

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }), useLocalSearchParams: () => ({ id: ctx.id }) }))
vi.mock('../src/runtime/connection', () => ({
  useConnection: () => ({ conn: ctx.conn, info: { macName: '맥', serverVersion: '9.9.9' }, appVersion: '0.2.0' }),
  connection: { reconnectNow: vi.fn() },
}))
vi.mock('../src/runtime/list', () => ({
  useList: () => ctx.list,
  useCollapseVersion: () => 0,
  listStore: { isUnread: () => false, markRead: vi.fn(), refresh: vi.fn() },
  collapse: { isCollapsed: () => ctx.collapsed, toggle: vi.fn() },
}))
vi.mock('../src/runtime/chat', () => ({
  useChat: () => ({ channel: null, phase: { kind: 'idle' }, gen: null, items: [], hasOlder: false, loadingOlder: false, receivedAt: null }),
  chatStore: { open: vi.fn(), close: vi.fn(), loadOlder: vi.fn(), retry: vi.fn() },
}))
vi.mock('../src/ui/Conversation', () => ({ Conversation: () => <i data-conversation /> }))
// LIFE-582 쓰기 — 대화 화면이 입력 저장소를 연다(다른 화면 시험과 같은 mock).
vi.mock('../src/runtime/input', () => ({ useInput: () => ({ entries: [] }), inputStore: { send: vi.fn(), stop: vi.fn(), answer: vi.fn(), cancel: vi.fn(), retry: vi.fn(), dismiss: vi.fn() } }))
vi.mock('react-native', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  TextInput: () => <textarea />,
  RefreshControl: () => null,
  ActivityIndicator: () => null,
  Platform: { select: (value: { android: string }) => value.android },
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('../src/ui/StatusGlyph', () => ({
  Avatar: ({ dot }: { dot: string }) => <i data-avatar-dot={dot} />,
  StatusGlyph: ({ dot }: { dot: string }) => <i data-status-dot={dot} />,
}))

function loadRaw(): Record<string, unknown> {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/list-588-message.json'), 'utf8'))
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('고정본 모양')
  return Object.fromEntries(Object.entries(raw))
}

function snapshot(raw: Record<string, unknown> = loadRaw()): ListSnapshot {
  const message = parseListMessage(raw)
  if (message === null) throw new Error('파서 거절')
  return { phase: { kind: 'ready', receivedAt: 1, message }, flashUntil: {}, ledgerVersion: 0, failure: null }
}

const connected: ConnState = { kind: 'connected', since: 1, lastAliveAt: 1 }
const HEADS = ['↳ corral · Detached HEAD @ deadbee', '↳ LIFE-581-mobile-chat', '↳ LIFE-581-mobile-chat-claude', '↳ LIFE-588-worktree-label']

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  ctx.conn = connected
  ctx.list = snapshot()
  ctx.collapsed = false
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

describe('W3ⓓ 목록 화면 — 하위 머리 글이 그려진다', () => {
  it('하위 머리 4개 · detached 작업 머리 · 위 섹션 crumb `레포 › 작업 › 하위`', async () => {
    const home = await render(<Home />)
    for (const head of HEADS) expect(home).toContain(head)
    // 순서 — 데스크톱 중첩 카드 순서.
    const at = HEADS.map((head) => home.indexOf(head))
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(home).toContain('corral · Detached HEAD @ 7cb34f3')
    expect(home).toContain('corral › feature/LIFE-564-mobile › LIFE-581-mobile-chat-claude')
    // 열린 세션 없는 하위는 머리가 없다(D2) — 보존 행 셋째 줄에 출신만(머리 4개 밖).
    expect(home).toContain('↳ no-live-child')
    expect(home.split('↳ ').length - 1).toBe(HEADS.length + 1)
  })

  it('W3ⓒ 작업을 접으면 하위 머리도 함께 접힌다', async () => {
    ctx.collapsed = true
    const home = await render(<Home />)
    for (const head of HEADS) expect(home).not.toContain(head)
    // 양성 대조: 작업 머리(접힌 꼴)는 남고, 하위 묶음의 행도 함께 사라진다(개수·점은 list-588.test.ts W3ⓒ).
    expect(home).toContain('feature/LIFE-564-mobile')
    expect(home).not.toContain('581 코디')
  })
})

describe('W5 대화 머리 — 화면 코드 무변경으로 서버 출신 글을 따라온다', () => {
  it('detached 출신 채널 머리에 `↳ corral @ deadbee` · 작업은 한 줄 꼴', async () => {
    ctx.id = 'd1'
    const channel = await render(<Channel />)
    expect(channel).toContain('↳ corral @ deadbee')
    expect(channel).not.toContain('Detached HEAD')
    expect(channel).toContain('corral › feature/LIFE-564-mobile')
  })

  it('detached 루트 작업 채널 머리 `레포 › 작업` 은 짧은 꼴', async () => {
    ctx.id = 'r1'
    const channel = await render(<Channel />)
    expect(channel).toContain('corral › corral @ 7cb34f3')
    expect(channel).not.toContain('Detached HEAD')
  })
})

describe('R1-A1 묶음 불변식이 깨진 메시지 — 화면', () => {
  for (const item of MALFORMED) {
    it(`${item.name} — 하위 머리 0 · React key 경고 0 · 출신 복원`, async () => {
      ctx.list = snapshot(withFeatChannels(loadRaw(), item.change))
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        const home = await render(<Home />)
        for (const head of HEADS) {
          // 머리 꼴 글(detached 긴 꼴)은 사라지고, 브랜치 하위 이름은 행 셋째 줄 `↳ 출신` 으로만 남는다.
          if (head.includes('Detached HEAD')) expect(home).not.toContain(head)
        }
        expect(home).toContain('↳ corral @ deadbee')
        expect(home).toContain('↳ LIFE-588-worktree-label')
        expect(errors.mock.calls.filter((call) => String(call[0]).includes('same key'))).toEqual([])
      } finally {
        errors.mockRestore()
      }
    })
  }

  it('양성 대조 — 정상 메시지도 key 경고 0, 머리 그대로', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const home = await render(<Home />)
      for (const head of HEADS) expect(home).toContain(head)
      expect(errors.mock.calls.filter((call) => String(call[0]).includes('same key'))).toEqual([])
    } finally {
      errors.mockRestore()
    }
  })
})
