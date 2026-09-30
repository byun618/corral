// monitoring 판단 (LIFE-462 #10) — **이 한 곳**에서만 한다.
//
// 판독층(`main/transcript-lifecycle.ts`)은 herdr 를 모른다. 거기서 온 열린 작업 목록·턴 결과와 herdr 가 준 pane 상태를
// 여기서 합친다. 정의는 Orca #16201 이다(00-analysis §9, `raw/grok/grok-lifecycle-sources.md` §6.2):
// 리드 턴이 끝났는데 **에이전트가 아닌** 백그라운드 작업이 남아 있으면 monitoring. 살아 있는 서브에이전트가
// 있으면(비동기 에이전트 작업이든 동기 호출 중이든) monitoring 이 아니다 — 그건 자식 행이 있는 상태다.
//
// # 턴 끝 = 둘 중 하나
//
//   · herdr `AgentStatus` 가 `idle`·`done`
//   · herdr 가 `working` 인데 기록의 턴 결과(`turnOutcome`, LIFE-458)가 있다 — 마지막 턴이 끝났고 새 턴이 아직 시작 안 했다.
//     herdr 의 grok 통합은 턴을 끝낸 뒤에도(`turn_completed end_turn`) 백그라운드 작업이 도는 동안 내내 `working` 을 준다
//     (네이티브 실측 `raw/claude/l10/runs/n34-grok-timeline.json`). herdr 만 보면 grok 은 monitoring 이 영영 안 선다.
//     `turnOutcome` 은 새 턴이 시작되면(사람 발화·통지·도구 결과) 풀리므로 도는 턴을 끝났다고 읽지 않는다
// `blocked`(사람 대기 — Orca 우선순위 needs-attention > monitoring)·`unknown`(에이전트를 모른다)은 턴 끝으로 치지 않는다.
import type { AgentStatus, SessionLifecycle, TurnOutcome } from './types.js'

export function isMonitoring(input: { agentStatus: AgentStatus; turnOutcome: TurnOutcome | null; lifecycle: SessionLifecycle }): boolean {
  const { agentStatus, turnOutcome, lifecycle } = input
  const turnEnded = agentStatus === 'idle' || agentStatus === 'done' || (agentStatus === 'working' && turnOutcome !== null)
  if (!turnEnded) return false
  if (lifecycle.state !== 'known') return false
  if (lifecycle.subagents.length > 0 || lifecycle.subagentOverflow > 0) return false
  if (lifecycle.tasks.some((task) => task.kind === 'agent')) return false
  // 넘친 작업은 종류를 모른다 — 실린 것 중 에이전트가 아닌 작업이 있어야 선다.
  return lifecycle.tasks.some((task) => task.kind !== 'agent')
}
