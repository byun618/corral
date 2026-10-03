// LIFE-493 K2 — 탭 선두 대응표의 **모든 칸** (`specs/LIFE-493-tabbar/raw/claude/k2-tab-status-map.md`).
// ⓐ pane 입력 → 탭 선두 ⓑ pane 여러 개 집계(permission 우선) + 배지 사다리 ⓒ 선두 4갈래(벨·점·로고·셸) ⓓ 벨은 라이브 상태면 숨는다.
import { describe, expect, it } from 'vitest'
import { emptyAgentState } from '../../shared/agent-state.js'
import { EMPTY_SESSION_DIGEST, type AgentStatus, type BlockedReason, type PaneRow, type SessionDigest, type SessionLifecycle, type TabRow } from '../../shared/types.js'
import type { AgentDot } from './agent-dot.js'
import { tabBadge, tabLeading, tabStatus, type TabBadge, type TabStatus } from './tab-status.js'

const SHELL_TASK: SessionLifecycle = { state: 'known', tasks: [{ id: 'b1', kind: 'shell', label: 'npm test', startedAt: 1 }], taskOverflow: 0, subagents: [], subagentOverflow: 0 }

function pane(input: {
  id?: string
  agent?: string | null
  status: AgentStatus
  reason?: BlockedReason | null
  digest?: Partial<SessionDigest>
  observed?: { at: number; via: 'event' | 'snapshot' }
}): PaneRow {
  const agentState = { ...emptyAgentState(input.observed?.at ?? 0), blockedReason: input.reason ?? null, observedVia: input.observed?.via ?? 'snapshot' }
  return {
    paneId: input.id ?? 'p1', tabId: 't1', workspaceId: 'w1', title: '', agent: input.agent === undefined ? 'claude' : input.agent,
    agentStatus: input.status, agentState, cwd: null, focused: false, agentSession: null, digest: { ...EMPTY_SESSION_DIGEST, ...input.digest },
  }
}
const tab = (panes: PaneRow[]): TabRow => ({ tabId: 't1', workspaceId: 'w1', label: '', number: 1, order: 0, agentStatus: 'idle', focused: false, panes, digest: EMPTY_SESSION_DIGEST })
const lead = (panes: PaneRow[], unread: string[] = []) => tabLeading({ tab: tab(panes), unreadPanes: new Set(unread) })

describe('ⓐ pane 입력 → 탭 선두 (대응표 한 행 = 한 it)', () => {
  it('working → 스피너 + 로고', () => expect(lead([pane({ status: 'working' })])).toEqual({ kind: 'dot', dot: 'working', agent: 'claude' }))
  it('idle(확인됨) → 점 없이 로고만 (Orca idle 탭)', () => expect(lead([pane({ status: 'idle' })])).toEqual({ kind: 'agent', agent: 'claude' }))
  it('herdr done 인데 확인됨 → 로고만 — 확인 경계는 corral 장부가 정한다(LIFE-471)', () =>
    expect(lead([pane({ status: 'done' })])).toEqual({ kind: 'agent', agent: 'claude' }))
  it('확인 안 된 완료(herdr done) → 벨 + 로고', () => expect(lead([pane({ status: 'done' })], ['p1'])).toEqual({ kind: 'bell', agent: 'claude' }))
  it('확인 안 된 완료(herdr 가 seen 처리해 idle) → 벨 + 로고', () => expect(lead([pane({ status: 'idle' })], ['p1'])).toEqual({ kind: 'bell', agent: 'claude' }))
  it('unknown → 점 없이 로고 — Orca 탭에 「모름」 글리프가 없다(사유는 대응표)', () =>
    expect(lead([pane({ status: 'unknown' })])).toEqual({ kind: 'agent', agent: 'claude' }))
  it('blocked + question → 질문 아이콘', () => expect(lead([pane({ status: 'blocked', reason: 'question' })])).toEqual({ kind: 'dot', dot: 'waiting', agent: 'claude' }))
  it('blocked + permission → 질문 아이콘', () => expect(lead([pane({ status: 'blocked', reason: 'permission' })])).toEqual({ kind: 'dot', dot: 'waiting', agent: 'claude' }))
  it('blocked + 사유 unknown + 대기 질문 → 질문 아이콘', () =>
    expect(lead([pane({ status: 'blocked', reason: 'unknown', digest: { pendingQuestions: [{ question: 'Go?', header: null, options: [], multiSelect: null }] } })]))
      .toEqual({ kind: 'dot', dot: 'waiting', agent: 'claude' }))
  for (const reason of ['trust', 'login', 'update', 'unknown', null] as const) {
    it(`blocked + 사유 ${String(reason)} → 빨간 점 (사람이 답해서 풀리지 않는 막힘)`, () =>
      expect(lead([pane({ status: 'blocked', reason })])).toEqual({ kind: 'dot', dot: 'blocked', agent: 'claude' }))
  }
  it('턴 결과 interrupted → 빨간 점', () =>
    expect(lead([pane({ status: 'idle', digest: { turnOutcome: { outcome: 'interrupted', reason: null } } })])).toEqual({ kind: 'dot', dot: 'interrupted', agent: 'claude' }))
  it('턴 결과 failed → 빨간 점(interrupted 칸)', () =>
    expect(lead([pane({ status: 'idle', digest: { turnOutcome: { outcome: 'failed', error: null } } })])).toEqual({ kind: 'dot', dot: 'failed', agent: 'claude' }))
  it('턴 끝 + 백그라운드 작업 → Activity(monitoring)', () =>
    expect(lead([pane({ status: 'idle', digest: { lifecycle: SHELL_TASK } })])).toEqual({ kind: 'dot', dot: 'monitoring', agent: 'claude' }))
  it('새 턴의 working 이 지난 턴 결과보다 뒤 → 결과를 버리고 스피너', () =>
    expect(lead([pane({ status: 'working', observed: { at: 200, via: 'event' }, digest: { turnOutcome: { outcome: 'interrupted', reason: null }, turnOutcomeAt: 100 } })]))
      .toEqual({ kind: 'dot', dot: 'working', agent: 'claude' }))
})

describe('ⓑ 탭 안 pane 여러 개 — 집계는 permission 우선 (Orca resolveWorktreeStatus)', () => {
  const cases: [AgentDot[], TabStatus | null, AgentDot | null][] = [
    [['working', 'waiting'], 'permission', 'waiting'],
    [['working', 'blocked'], 'permission', 'blocked'],
    [['blocked', 'waiting'], 'permission', 'waiting'],
    [['monitoring', 'working'], 'working', 'working'],
    [['interrupted', 'monitoring'], 'monitoring', 'monitoring'],
    [['done', 'failed'], 'interrupted', 'failed'],
    [['idle', 'done'], 'done', 'done'],
    [['idle', 'unverifiable'], null, null],
    [[], null, null],
  ]
  for (const [dots, status, dot] of cases) {
    it(`[${dots.join(', ')}] → ${String(status)}`, () => expect(tabStatus(dots)).toEqual(status === null ? null : { status, dot }))
  }
  it('pane 둘(작업 중 + 질문 대기) → 탭은 질문 아이콘', () =>
    expect(lead([pane({ id: 'a', status: 'working' }), pane({ id: 'b', status: 'blocked', reason: 'question' })])).toEqual({ kind: 'dot', dot: 'waiting', agent: 'claude' }))
})

describe('ⓑ 배지 사다리 working > permission > monitoring > unread > done > interrupted', () => {
  const ladder: [TabStatus | null, boolean, TabBadge | null][] = [
    ['working', true, 'working'],
    ['permission', true, 'permission'],
    ['monitoring', true, 'monitoring'],
    ['done', true, 'unread'],
    ['interrupted', true, 'unread'],
    [null, true, 'unread'],
    ['working', false, 'working'],
    ['permission', false, 'permission'],
    ['monitoring', false, 'monitoring'],
    ['done', false, 'done'],
    ['interrupted', false, 'interrupted'],
    [null, false, null],
  ]
  for (const [status, hasUnread, badge] of ladder) {
    it(`${String(status)} · 안 읽음 ${hasUnread} → ${String(badge)}`, () => expect(tabBadge({ status, hasUnread })).toBe(badge))
  }
})

describe('ⓒⓓ 선두 4갈래 · 벨 숨김', () => {
  it('라이브 상태(작업 중)면 다른 pane 의 안 읽음이 있어도 벨이 아니라 스피너다', () =>
    expect(lead([pane({ id: 'a', status: 'working' }), pane({ id: 'b', status: 'done' })], ['b'])).toEqual({ kind: 'dot', dot: 'working', agent: 'claude' }))
  it('라이브 상태(질문 대기)도 벨을 숨긴다', () =>
    expect(lead([pane({ id: 'a', status: 'blocked', reason: 'question' }), pane({ id: 'b', status: 'done' })], ['b'])).toEqual({ kind: 'dot', dot: 'waiting', agent: 'claude' }))
  it('중단(라이브 아님) + 안 읽음 → 벨이 이긴다', () =>
    expect(lead([pane({ id: 'a', status: 'idle', digest: { turnOutcome: { outcome: 'interrupted', reason: null } } }), pane({ id: 'b', status: 'done' })], ['b']))
      .toEqual({ kind: 'bell', agent: 'claude' }))
  it('확인 안 된 완료는 벨로만 나온다 — 탭에서 체크(done) 점이 서는 입력은 없다(대응표 「대응 못 하는 칸」)', () => {
    for (const status of ['idle', 'done'] as const) expect(lead([pane({ status })], ['p1']).kind).toBe('bell')
  })
  it('셸 탭 → 셸 아이콘', () => expect(lead([pane({ agent: null, status: 'unknown' })])).toEqual({ kind: 'shell' }))
  it('모르는 에이전트 문자열 → 정체 없음(셸 아이콘) — 없는 로고를 지어내지 않는다', () => expect(lead([pane({ agent: 'aider', status: 'idle' })])).toEqual({ kind: 'shell' }))
  it('셸 pane 에 안 읽음 → 벨만(로고 없음)', () => expect(lead([pane({ agent: null, status: 'done' })], ['p1'])).toEqual({ kind: 'bell', agent: null }))
  it('로고는 첫 에이전트 pane(라벨 규칙 `tabAgent` 와 같다)', () =>
    expect(lead([pane({ id: 'a', agent: null, status: 'idle' }), pane({ id: 'b', agent: 'codex', status: 'idle' }), pane({ id: 'c', agent: 'grok', status: 'idle' })]))
      .toEqual({ kind: 'agent', agent: 'codex' }))
  it('grok 로고', () => expect(lead([pane({ agent: 'grok', status: 'working' })])).toEqual({ kind: 'dot', dot: 'working', agent: 'grok' }))
})
