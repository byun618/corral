// @vitest-environment happy-dom
// LIFE-582 R2-A8 — 질문 직접 입력 초안이 재연결 동안 남는다. 리뷰 r2 의 UI 재현(`raw/review/codex-r2-raw/review-draft.test.tsx`)을 옮겨 기대를 뒤집었다:
// RN·expo-router·연결/목록/대화 저장소만 가짜, 실제 대화 화면(Channel)·입력창(Composer)을 그린다. 네이티브 실행이 아니다.
import fs from 'node:fs'
import path from 'node:path'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Channel from '../app/channel/[id]'
import type { ConnState } from '../src/core/connection'
import { parseListMessage } from '../src/core/list'
import type { ListSnapshot } from '../src/core/list-store'
import type { ChatItem } from '../src/core/chat'

const ctx = vi.hoisted(() => {
  const state: { conn: ConnState; list: ListSnapshot | null; collapsed: boolean; id: string; items: ChatItem[]; edit:((s:string)=>void)|null } = { conn: { kind: 'loading' }, list: null, collapsed: false, id: 'd1', items:[],edit:null }
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
  useChat: () => ({ channel: null, phase: { kind: 'idle' }, gen: null, items: ctx.items, hasOlder: false, loadingOlder: false, receivedAt: null }),
  chatStore: { open: vi.fn(), close: vi.fn(), loadOlder: vi.fn(), retry: vi.fn() },
}))
vi.mock('../src/ui/Conversation', () => ({ Conversation: () => <i data-conversation /> }))
// LIFE-582 쓰기 — 대화 화면이 입력 저장소를 연다(다른 화면 시험과 같은 mock).
vi.mock('../src/runtime/input', () => ({ useInput: () => ({ entries: [] }), inputStore: { send: vi.fn(), stop: vi.fn(), answer: vi.fn(), cancel: vi.fn(), retry: vi.fn(), dismiss: vi.fn() } }))
vi.mock('react-native', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  TextInput: ({value,onChangeText}:{value:string;onChangeText:(s:string)=>void}) => {ctx.edit=onChangeText;return <textarea value={value} readOnly />} ,
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

const QUESTION: ChatItem = { id: 10, kind: 'question', call: 'toolu-10', digest: 'ab'.repeat(16), questions: [{ question: 'question', header: null, options: [{ label: 'a', description: null }, { label: 'b', description: null }], multiSelect: false, preview: false }], state: 'pending', answer: null, at: null, clipped: false }
const reconnecting: ConnState = { kind: 'reconnecting', attempt: 2, since: 1, lastConnectedAt: 1, reason: 'network', offline: false }
const typed = (): string | undefined => host.querySelector('textarea')?.value

describe('R2-A8 질문 직접 입력 초안 — 재연결', () => {
  it('connected → reconnecting → connected 동안 쓴 글이 남는다', async () => {
    ctx.items = [QUESTION]
    await render(<Channel />)
    await act(async () => ctx.edit?.('typed answer'))
    expect(typed()).toBe('typed answer')
    ctx.conn = reconnecting
    await render(<Channel />)
    expect(typed()).toBe('typed answer')
    ctx.conn = connected
    await render(<Channel />)
    expect(typed()).toBe('typed answer')
  })
  it('대조 — 질문이 닫히면(아는 상태에서 질문이 사라짐) 입력창이 새로 열린다', async () => {
    ctx.items = [QUESTION]
    await render(<Channel />)
    await act(async () => ctx.edit?.('typed answer'))
    ctx.items = [{ ...QUESTION, state: 'answered' }]
    await render(<Channel />)
    expect(typed()).toBe('')
  })
})
