// monitoring 판단 (LIFE-462 #10) — **이 한 곳**에서만 한다.
//
// 판독층(`main/transcript-lifecycle.ts`)은 herdr 를 모른다. 거기서 온 열린 작업 목록과 herdr 가 준 pane 상태를
// 여기서 합친다. 정의는 Orca #16201 이다(00-analysis §9, `raw/grok/grok-lifecycle-sources.md` §6.2):
// 리드 턴이 끝났는데 **에이전트가 아닌** 백그라운드 작업이 남아 있으면 monitoring. 살아 있는 서브에이전트가
// 있으면(비동기 에이전트 작업이든 동기 호출 중이든) monitoring 이 아니다 — 그건 자식 행이 있는 상태다.
//
// 턴 끝 = herdr `AgentStatus` 가 `idle`·`done`. `working`·`blocked` 는 턴 진행(또는 사람 대기), `unknown` 은 모른다.
// 458 `turnOutcome` 은 쓰지 않는다 — 꼬리 창 판독이라 창 밖으로 밀린 턴 끝을 null 로 주고, 새 턴이 시작돼 풀린 것과
// 구분하지 않는다. herdr 상태는 매 이벤트로 오는 "지금" 이다.
import type { AgentStatus, SessionLifecycle } from './types.js'

export function isMonitoring(input: { agentStatus: AgentStatus; lifecycle: SessionLifecycle }): boolean {
  const { agentStatus, lifecycle } = input
  if (agentStatus !== 'idle' && agentStatus !== 'done') return false
  if (lifecycle.state !== 'known') return false
  if (lifecycle.subagents.length > 0 || lifecycle.subagentOverflow > 0) return false
  if (lifecycle.tasks.some((task) => task.kind === 'agent')) return false
  // 넘친 작업은 종류를 모른다 — 실린 것 중 에이전트가 아닌 작업이 있어야 선다.
  return lifecycle.tasks.some((task) => task.kind !== 'agent')
}
