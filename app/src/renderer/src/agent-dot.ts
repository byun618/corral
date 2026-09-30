// 사이드바 에이전트 행의 **상태 점** (LIFE-467 K4 · D5) — corral 상태를 Orca 1.4.198 점 어휘로 옮긴다.
//
// Orca 는 점을 `AgentDotState` 로 그린다(`components/AgentStateDot.tsx:22-43`): 스피너(working) ·
// Activity(monitoring) · CircleCheck(done) · CircleDashed(unverifiable) · 질문 아이콘(waiting/permission) ·
// 빨간 점(blocked/interrupted/failed) · 흐린 점(idle). corral 은 상태가 다섯 값(`AgentStatus`)이고 나머지 결은
// 부가 칸(`blockedReason`·`pendingQuestions`·`turnOutcome`·`lifecycle`)에 있다 — 그 칸들을 **한 함수**에서 합쳐
// 점 하나를 고른다. 대응표 전문과 칸마다의 사유는 `specs/LIFE-467-sidebar/raw/claude/k4-dot-map.md`.
//
// 조용히 idle 로 떨어뜨리는 칸이 없다: `unknown`(herdr 가 에이전트 상태를 모른다)은 idle 이 아니라
// **점선 원(unverifiable)** 이다 — "모른다" 를 "쉬고 있다" 로 그리면 화면이 아는 척을 한다.

import { isMonitoring } from '../../shared/lifecycle.js'
import type { AgentStatus, BlockedReason, SessionLifecycle, SessionQuestion, TurnOutcome } from '../../shared/types.js'

export type AgentDot = 'waiting' | 'blocked' | 'working' | 'monitoring' | 'interrupted' | 'failed' | 'done' | 'unverifiable' | 'idle'

/**
 * 묶음 알약의 상태 그룹 순서 — Orca `SUMMARY_STATE_ORDER`(`worktree-card-agent-summary.ts:11-21`) 그대로다.
 * Orca 배열에 없는 `failed` 는 같은 빨간 점 무리인 `interrupted` 바로 뒤에 둔다.
 */
export const AGENT_DOT_ORDER: readonly AgentDot[] = ['waiting', 'blocked', 'working', 'monitoring', 'interrupted', 'failed', 'done', 'unverifiable', 'idle']

/** 점의 뜻 (툴팁·접근성 라벨). 문구는 한국어 UI 규칙을 따른다(D17 — Orca 는 영문 하드코딩). */
export const AGENT_DOT_LABEL: Record<AgentDot, string> = {
  waiting: '입력 대기',
  blocked: '막힘',
  working: '작업중',
  monitoring: '백그라운드 작업 감시 중',
  interrupted: '중단됨',
  failed: '실패',
  done: '완료',
  unverifiable: '상태 모름',
  idle: '대기',
}

/** 질문 아이콘으로 그리는 `blocked` 사유 — 사람이 **답하면 풀리는** 대기다. */
const ASKING_REASONS: readonly BlockedReason[] = ['question', 'permission']

export function agentDot(input: {
  agentStatus: AgentStatus
  blockedReason: BlockedReason | null
  pendingQuestions: readonly SessionQuestion[] | null
  turnOutcome: TurnOutcome | null
  lifecycle: SessionLifecycle
}): AgentDot {
  const { agentStatus, blockedReason, pendingQuestions, turnOutcome, lifecycle } = input
  switch (agentStatus) {
    case 'blocked':
      // 사유만 보면 안 된다 — 네이티브 실측에서 claude 질문 대기가 `blockedReason: 'unknown'` 으로 왔다
      // (`raw/claude/k1/dump-q-claude-question.json`). 기록의 대기 질문이 그 빈칸을 메운다.
      if (blockedReason !== null && ASKING_REASONS.includes(blockedReason)) return 'waiting'
      if (pendingQuestions !== null && pendingQuestions.length > 0) return 'waiting'
      return 'blocked'
    case 'unknown':
      return 'unverifiable'
    case 'working':
    case 'idle':
    case 'done': {
      // 턴 결과가 있으면 그 턴은 끝났다(`TurnOutcome` 주석) — Orca 도 `interrupted` 를 다른 모든 점보다 앞에 둔다
      // (`worktree-card-agent-summary.ts:23-28`).
      if (turnOutcome?.outcome === 'interrupted') return 'interrupted'
      if (turnOutcome?.outcome === 'failed') return 'failed'
      if (isMonitoring({ agentStatus, turnOutcome, lifecycle })) return 'monitoring'
      return agentStatus
    }
  }
}
