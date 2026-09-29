// 에이전트 상태의 **판정 한 벌** (LIFE-456). GUI 경로와 CLI 경로가 같은 말을 하도록
// 어휘·사유·롤업·전이 기록을 여기 한 곳에 둔다 — 두 벌 판정 금지(기준 S6·S3).
//
// `types.ts` 는 타입만 두는 파일이라(그 파일 머리 주석) 값과 함수는 이 형제 모듈에 있다.
// herdr 의 와이어 모양은 여기에도 없다 — 어댑터가 옮겨 담은 뒤의 corral 타입만 다룬다.

import type {
  AgentObservedVia,
  AgentState,
  AgentStatus,
  AgentTransition,
  BlockedReason,
} from './types.js'

/** 이력 보존 개수 — Orca 198 `stateHistory` 최대 20 에 맞춘다(`00-synthesis` #4). */
export const AGENT_HISTORY_LIMIT = 20

/** 아직 아무것도 관측하지 않은 pane 의 자리값. */
export function emptyAgentState(observedAt: number): AgentState {
  return { blockedReason: null, observedAt, observedVia: 'snapshot', enteredDoneAt: null, history: [] }
}

/**
 * herdr 의 상태 문자열을 corral 의 `AgentStatus` 로 읽는다 — **다섯 값 전부 산다**.
 *
 * 모르는 문자열만 `unknown` 이다. `done` 을 여기서 접던 것이 LIFE-456 이 고치는 결함이고,
 * 그래서 이 함수를 지난 뒤로는 `agent_status.unmapped` 로그에 `done` 이 더는 안 나온다.
 * 읽지 못한 값은 호출자가 로그에 남긴다(어댑터) — 이 모듈은 로거를 모른다.
 */
export function parseAgentStatus(value: unknown): AgentStatus | null {
  if (typeof value !== 'string') return null
  switch (value) {
    case 'idle':
      return 'idle'
    case 'working':
      return 'working'
    case 'blocked':
      return 'blocked'
    case 'done':
      return 'done'
    case 'unknown':
      return 'unknown'
    default:
      return null
  }
}

/**
 * `blocked` 의 사유를 **한 곳에서** 판정한다 (S3 — CLI 와 GUI 가 같은 함수를 쓴다).
 *
 * 입력은 herdr `state_labels` 다. **실측상 claude·codex·grok 에서 이 맵은 비어 온다**
 * (`raw/claude/s3/s3-state-labels-findings.md` — 라이브 blocked pane 에서 키 자체가 없었고,
 * 설치된 매니페스트 전량에 `label` 키가 0건, 과거 작업 원자료에도 채워진 예가 0건).
 * 그래서 이 함수는 그 세 provider 에 대해 **항상 `null`** 을 돌려준다 — 그 공백이 결과 문서의
 * provider × 사유 표에 사유와 함께 적힌다.
 *
 * `null` 과 `'unknown'` 은 다르다:
 *   · `null`    = herdr 가 **아무 말도 안 했다** (공백 — 지금 세 provider 가 전부 이 칸)
 *   · `unknown` = 말은 했는데 **우리가 못 알아들었다** (라벨이 있는데 어느 갈래도 아님)
 * 이 구분이 없으면 "출처에 없다" 와 "우리가 못 읽는다" 가 화면에서 같아진다.
 */
export function blockedReasonFromLabels(labels: Readonly<Record<string, string>> | null | undefined): BlockedReason | null {
  if (labels === null || labels === undefined) return null
  const values = Object.values(labels)
  if (values.length === 0) return null
  const text = values.join(' ').toLowerCase()
  if (text.includes('trust')) return 'trust'
  if (text.includes('login') || text.includes('sign in') || text.includes('auth')) return 'login'
  if (text.includes('permission') || text.includes('allow')) return 'permission'
  if (text.includes('update')) return 'update'
  return 'unknown'
}

/**
 * 탭·워크스페이스 **롤업 순서** (S5).
 *
 * corral 이 자기 pane 집합에서 직접 접는다 — herdr 가 탭·워크스페이스 이벤트에 실어 주는
 * `agent_status` 는 쓰지 않는다. 두 출처를 섞으면 우선순위가 어긋나 탭 점이 30초마다
 * 뒤집힌다(H3 의 실제 증상). 출처를 하나로 두는 것이 이 결함의 수정이다.
 *
 * 자리 잡기:
 *   · `blocked` 가 맨 위 — 사람을 기다리는 유일한 상태다
 *   · `done` 은 `working` 아래, `unknown` 위 — **끝났는데 아직 안 본 것**이라 idle 보다는
 *     눈길을 받아야 하고, 아직 도는 working 보다는 급하지 않다
 *   · `unknown` 이 `idle` 위인 것은 전부터의 규칙이다(Orca `unverifiable` 자리)
 */
export const AGENT_STATUS_ROLLUP_ORDER: readonly AgentStatus[] = ['blocked', 'working', 'done', 'unknown', 'idle']

/** pane 집합 하나를 탭·워크스페이스 한 값으로 접는다. pane 이 없으면 `unknown`. */
export function rollupAgentStatus(statuses: readonly AgentStatus[]): AgentStatus {
  if (statuses.length === 0) return 'unknown'
  for (const status of AGENT_STATUS_ROLLUP_ORDER) if (statuses.includes(status)) return status
  return 'unknown'
}

/**
 * 상태 전이를 기록한다 (S1 관측 시각 · S15ⓐⓑⓒ).
 *
 * **같은 값이 다시 와도 `observedAt` 을 갱신하지 않는다** — 30초 재동기가 같은 상태를 계속
 * 실어 오는데 그때마다 시각을 밀면 "이 상태로 들어온 지 얼마" 가 영영 0에 붙는다. 갱신은
 * 값이 **바뀔 때만** 이고, 그게 이 칸이 말하는 「처음 관측한 시각」의 뜻이다.
 *
 * `previousStatus: null` 은 **그 pane 을 이제 막 처음 봤다**는 뜻이다. 그때는 이력을 만들지
 * 않는다: 「몰랐다 → working」 은 전이가 아니라 관측의 시작이고, 그걸 `unknown` 전이로 적으면
 * 모든 pane 의 이력이 있지도 않았던 `unknown` 한 칸으로 시작한다(첫 회차에 실제로 그랬다).
 */
export function recordAgentTransition(input: {
  previousStatus: AgentStatus | null
  previousState: AgentState
  nextStatus: AgentStatus
  blockedReason: BlockedReason | null
  observedAt: number
  observedVia: AgentObservedVia
}): AgentState {
  const { previousStatus, previousState, nextStatus, blockedReason, observedAt, observedVia } = input
  if (previousStatus === null) {
    // 처음 보는 pane — 상태를 심기만 한다. 지나온 것이 없으므로 이력도 없다.
    return {
      blockedReason,
      observedAt,
      observedVia,
      enteredDoneAt: nextStatus === 'done' ? observedAt : null,
      history: [],
    }
  }
  if (nextStatus === previousStatus) {
    // 값이 그대로면 시각·이력은 건드리지 않는다. 사유만 새로 알게 됐을 수 있어 그것만 받는다.
    return blockedReason === previousState.blockedReason ? previousState : { ...previousState, blockedReason }
  }
  const previous: AgentTransition = {
    status: previousStatus,
    observedAt: previousState.observedAt,
    observedVia: previousState.observedVia,
  }
  return {
    blockedReason,
    observedAt,
    observedVia,
    enteredDoneAt: nextStatus === 'done' ? observedAt : previousState.enteredDoneAt,
    history: [previous, ...previousState.history].slice(0, AGENT_HISTORY_LIMIT),
  }
}
