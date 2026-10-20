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

import { isMonitoring } from './lifecycle.js'
import type { AgentObservedVia, AgentStatus, BlockedReason, SessionLifecycle, SessionQuestion, TurnOutcome } from './types.js'

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
  /**
   * 결과의 **신선도** 재료 (LIFE-467 R2 · fix-r2 S1) — 지금 상태에 들어선 시각과 그 관측 경로(`agentState`), 그리고
   * 결과가 기록된 시각의 상한(`digest.turnOutcomeAt` — **결과와 같은 출처**). 없으면 결과를 그대로 믿는다(옛 동작).
   */
  freshness: { observedAt: number; observedVia: AgentObservedVia; outcomeAt: number | null } | null
}): AgentDot {
  const { agentStatus, blockedReason, pendingQuestions, lifecycle, freshness } = input
  const turnOutcome = staleOutcome({ agentStatus, freshness }) ? null : input.turnOutcome
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

/**
 * 새 턴이 이미 시작됐는데 **지난 턴의 결과**가 아직 붙어 있는가 (LIFE-467 R2 · fix-r2 S1).
 *
 * herdr 의 `working` 전이는 곧장 화면에 오고, 결과(`turnOutcome`)를 푸는 기록 판독은 별도 폴링(1.5s)이다 — 그 사이
 * 중단·실패 결과가 새 working 을 덮는다. 그래서 **working 에 들어선 시각이 결과가 기록된 시각(상한)보다 뒤**면
 * 그 결과는 지난 턴의 것으로 보고 뺀다. 진입 시각이 실제 전이(`event`)일 때만 따진다 — `snapshot` 은 진입 시각이
 * 아니라 corral 이 처음 본 시각이라 비교 근거가 못 된다(그때는 결과를 믿는다).
 *
 * 결과 시각은 **결과와 같은 출처**여야 한다(`digest.turnOutcomeAt`). r1 은 기록의 마지막 활동 시각(`lastActivityAt`)과
 * 견줬는데, grok 은 결과가 `updates.jsonl` 에, 활동 시각이 `chat_history` 에 있어 두 시계를 견준 셈이 됐다 — 새 결과가
 * 형제 파일에만 쌓이면 최신 중단·실패를 버렸다(review r2 S1). 결과 시각이 없으면 추정하지 않는다.
 *
 * grok 은 턴이 끝난 뒤에도 working 을 준다 — 그 working 은 결과보다 **먼저** 시작됐으므로 이 규칙에서 결과가 이긴다.
 */
function staleOutcome(input: {
  agentStatus: AgentStatus
  freshness: { observedAt: number; observedVia: AgentObservedVia; outcomeAt: number | null } | null
}): boolean {
  const { agentStatus, freshness } = input
  if (agentStatus !== 'working' || freshness === null) return false
  if (freshness.observedVia !== 'event' || freshness.outcomeAt === null) return false
  return freshness.observedAt > freshness.outcomeAt
}

/**
 * 대기 중 질문의 본문과, 본문이 없을 때의 이유 (LIFE-603 R1-N) — main 활동 기록과 렌더러 칩이 같이 쓴다.
 * 빈 목록(`[]`)은 null 과 같다(`agentDot` 의 `length > 0` 과 같은 판정). 이유는 사유에 맞춘다 — 권한 대기에 「질문 본문을 못 읽음」 을 달지 않는다.
 */
export function waitingQuestion({ blockedReason, pendingQuestions }: { blockedReason: BlockedReason | null; pendingQuestions: readonly SessionQuestion[] | null }): { text: string | null; reason: string | null } {
  if (pendingQuestions !== null && pendingQuestions.length > 0) return { text: pendingQuestions.map((entry) => entry.question).join('\n'), reason: null }
  if (blockedReason === 'permission') return { text: null, reason: '권한 승인을 기다립니다 — 에이전트 화면에서 확인하세요.' }
  return { text: null, reason: '이 에이전트의 질문 본문은 읽지 못합니다.' }
}
