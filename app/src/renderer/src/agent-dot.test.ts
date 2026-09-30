// K4 — corral 상태 → Orca 점 대응표의 **모든 칸** (`specs/LIFE-467-sidebar/raw/claude/k4-dot-map.md`).
// 표의 한 행 = 이 파일의 한 `it`. 대응 못 하는 칸을 조용히 idle 로 떨어뜨리지 않는지까지 본다.
import { describe, expect, it } from 'vitest'
import type { AgentStatus, BlockedReason, SessionLifecycle, SessionQuestion, TurnOutcome } from '../../shared/types.js'
import { AGENT_DOT_LABEL, AGENT_DOT_ORDER, agentDot } from './agent-dot.js'

const NO_SOURCE: SessionLifecycle = { state: 'unknown', reason: 'no-source' }
const EMPTY_KNOWN: SessionLifecycle = { state: 'known', tasks: [], taskOverflow: 0, subagents: [], subagentOverflow: 0 }
const SHELL_TASK: SessionLifecycle = { state: 'known', tasks: [{ id: 'b1', kind: 'shell', label: 'npm test', startedAt: 1 }], taskOverflow: 0, subagents: [], subagentOverflow: 0 }
const WITH_SUBAGENT: SessionLifecycle = {
  state: 'known', tasks: [{ id: 'b1', kind: 'shell', label: 'npm test', startedAt: 1 }], taskOverflow: 0,
  subagents: [{ id: 's1', name: null, description: null, agentType: null, background: true, startedAt: 1, status: 'running' }], subagentOverflow: 0,
}
const QUESTION: SessionQuestion[] = [{ question: 'Continue?', header: null, options: [{ label: 'Yes', description: null }], multiSelect: false }]

function dot(input: {
  status: AgentStatus
  reason?: BlockedReason | null
  questions?: SessionQuestion[] | null
  outcome?: TurnOutcome | null
  lifecycle?: SessionLifecycle
}) {
  return agentDot({
    agentStatus: input.status,
    blockedReason: input.reason ?? null,
    pendingQuestions: input.questions ?? null,
    turnOutcome: input.outcome ?? null,
    lifecycle: input.lifecycle ?? NO_SOURCE,
  })
}

describe('agentDot — K4 대응표', () => {
  it('working → working(스피너)', () => expect(dot({ status: 'working' })).toBe('working'))
  it('idle → idle(흐린 점)', () => expect(dot({ status: 'idle' })).toBe('idle'))
  it('done → done(체크)', () => expect(dot({ status: 'done' })).toBe('done'))
  it('unknown → unverifiable(점선 원) — idle 로 떨어뜨리지 않는다', () => expect(dot({ status: 'unknown' })).toBe('unverifiable'))

  it('blocked + question → waiting(질문 아이콘)', () => expect(dot({ status: 'blocked', reason: 'question' })).toBe('waiting'))
  it('blocked + permission → waiting(질문 아이콘 — Orca permission 과 같은 그림)', () => expect(dot({ status: 'blocked', reason: 'permission' })).toBe('waiting'))
  it('blocked + unknown 사유 + 대기 질문 → waiting (네이티브 실측: claude 질문 대기의 사유가 unknown)', () =>
    expect(dot({ status: 'blocked', reason: 'unknown', questions: QUESTION })).toBe('waiting'))
  it('blocked + null 사유 + 대기 질문 → waiting', () => expect(dot({ status: 'blocked', questions: QUESTION })).toBe('waiting'))
  it('blocked + trust → blocked(빨간 점)', () => expect(dot({ status: 'blocked', reason: 'trust' })).toBe('blocked'))
  it('blocked + login → blocked', () => expect(dot({ status: 'blocked', reason: 'login' })).toBe('blocked'))
  it('blocked + update → blocked', () => expect(dot({ status: 'blocked', reason: 'update' })).toBe('blocked'))
  it('blocked + unknown 사유(질문 없음) → blocked', () => expect(dot({ status: 'blocked', reason: 'unknown' })).toBe('blocked'))
  it('blocked + null 사유 → blocked', () => expect(dot({ status: 'blocked' })).toBe('blocked'))
  it('blocked + 빈 질문 배열 → blocked (빈 배열은 질문이 아니다)', () => expect(dot({ status: 'blocked', questions: [] })).toBe('blocked'))
  it('blocked 는 턴 결과·monitoring 보다 앞선다 — 사람을 기다리는 게 먼저다', () =>
    expect(dot({ status: 'blocked', outcome: { outcome: 'interrupted', reason: null }, lifecycle: SHELL_TASK })).toBe('blocked'))

  it('idle + turnOutcome interrupted → interrupted(빨간 점)', () => expect(dot({ status: 'idle', outcome: { outcome: 'interrupted', reason: null } })).toBe('interrupted'))
  it('done + turnOutcome interrupted → interrupted', () => expect(dot({ status: 'done', outcome: { outcome: 'interrupted', reason: 'x' } })).toBe('interrupted'))
  it('working + turnOutcome interrupted → interrupted (grok 은 턴 뒤에도 working 을 준다)', () =>
    expect(dot({ status: 'working', outcome: { outcome: 'interrupted', reason: null } })).toBe('interrupted'))
  it('idle + turnOutcome failed → failed(빨간 점)', () => expect(dot({ status: 'idle', outcome: { outcome: 'failed', error: 'rate_limit' } })).toBe('failed'))
  it('idle + turnOutcome completed → idle', () => expect(dot({ status: 'idle', outcome: { outcome: 'completed' } })).toBe('idle'))
  it('interrupted 는 monitoring 보다 앞선다 (Orca interrupted 우선)', () =>
    expect(dot({ status: 'idle', outcome: { outcome: 'interrupted', reason: null }, lifecycle: SHELL_TASK })).toBe('interrupted'))

  it('idle + 에이전트 아닌 백그라운드 작업 → monitoring(Activity)', () => expect(dot({ status: 'idle', lifecycle: SHELL_TASK })).toBe('monitoring'))
  it('done + 백그라운드 작업 → monitoring', () => expect(dot({ status: 'done', lifecycle: SHELL_TASK })).toBe('monitoring'))
  it('working + 턴 결과 + 백그라운드 작업 → monitoring (isMonitoring 한 곳)', () =>
    expect(dot({ status: 'working', outcome: { outcome: 'completed' }, lifecycle: SHELL_TASK })).toBe('monitoring'))
  it('working + 턴 결과 없음 + 백그라운드 작업 → working (도는 턴)', () => expect(dot({ status: 'working', lifecycle: SHELL_TASK })).toBe('working'))
  it('서브에이전트가 살아 있으면 monitoring 이 아니다 — 자식 행이 있는 상태', () => expect(dot({ status: 'idle', lifecycle: WITH_SUBAGENT })).toBe('idle'))
  it('열린 작업이 없으면 monitoring 이 아니다', () => expect(dot({ status: 'idle', lifecycle: EMPTY_KNOWN })).toBe('idle'))

  it('순서표는 점 9종을 한 번씩 담는다 · 라벨도 전부 있다', () => {
    expect(new Set(AGENT_DOT_ORDER).size).toBe(9)
    for (const value of AGENT_DOT_ORDER) expect(AGENT_DOT_LABEL[value].length).toBeGreaterThan(0)
  })
})
