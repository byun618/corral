// 에이전트 상태의 **판정 한 벌** (LIFE-456). GUI 경로와 CLI 경로가 같은 말을 하도록
// 어휘·사유·롤업·전이 기록을 여기 한 곳에 둔다 — 두 벌 판정 금지(기준 S6·S3).
//
// `types.ts` 는 타입만 두는 파일이라(그 파일 머리 주석) 값과 함수는 이 형제 모듈에 있다.
// herdr 의 와이어 모양은 여기에도 없다 — 어댑터가 옮겨 담은 뒤의 corral 타입만 다룬다.

import { isRecord, readArray, readRecord, readString } from './json.js'
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
 * herdr 탐지 규칙 id → blocked 사유 (S3).
 *
 * 출처는 설치된 탐지 매니페스트(`~/.local/state/herdr/agent-detection/remote/*.toml`)의 규칙
 * `id` 이고, corral 은 `agent.explain` 의 `matched_rule.id` 로 그 값을 받는다.
 * **매니페스트에서 실제로 갈리는 것만 적는다** — 규칙 하나가 두 뜻을 함께 받는 자리는
 * `unknown` 으로 남긴다. 거기서 억지로 가르면 화면이 없는 구분을 있는 것처럼 말한다.
 */
const BLOCKED_REASON_BY_RULE: Readonly<Record<string, BlockedReason>> = {
  // 권한 승인 — 규칙 이름이 곧 권한이다
  bash_permission_prompt: 'permission',
  generic_permission_prompt: 'permission',
  permission_hints_blocked: 'permission',
  permission_scope_selector: 'permission',
  // 사람에게 묻는 화면
  question_dialog_hints_blocked: 'question',
  option_dialog_blocked: 'question',
  mcp_elicitation_prompt: 'question',
  dynamic_workflow_prompt: 'question',
  // 그 밖
  trust_directory: 'trust',
  startup_update: 'update',
  // **일부러 안 적는 것** (실측 — `raw/claude/s3/s3-state-labels-findings.md` §⑤):
  //   · codex `live_strong_blocker` — 규칙 본문의 `any` 가 `allow command?`(권한)와
  //     `enter to submit answer`(질문)를 **함께** 받는다. 갈리지 않는다
  //   · claude `live_blocked_form` — 같은 이유로 권한과 질문이 한 규칙이다
  //   · `osc_title_blocked`·`weak_blocker`·`legacy_no_prompt_blocker` — 뜻이 「막혔다」뿐이다
  // 이것들은 아래에서 `unknown` 이 된다: 사유를 말은 하는데(라벨/규칙이 있다) 어느 갈래도 아니다.
}

/**
 * `blocked` 의 사유를 **한 곳에서** 판정한다 (S3 — CLI 와 GUI 가 같은 함수를 쓴다).
 *
 * 입력이 둘이다:
 *   · `labels`  — herdr `state_labels`. **실측상 claude·codex·grok 에서는 늘 비어 온다**
 *     (`raw/claude/s3/s3-state-labels-findings.md` §①④). 다른 provider·다음 herdr 를 위해
 *     남겨 둔 입력이지 지금 사유가 나오는 자리가 아니다
 *   · `ruleId`  — `agent.explain` 이 고른 규칙 id(`pickBlockedRule`). **사유의 실제 출처다**
 *
 * **CLI 와 GUI 가 이 함수에 같은 것을 먹인다** (fix-r1 F3). 전에는 GUI 만 `ruleId` 를 주고
 * CLI 는 `labels` 만 줘서, 같은 pane 이 창에서는 `permission`·CLI 에서는 `unknown` 이었다 —
 * 한 함수를 쓰는 것만으로는 한 어휘가 되지 않는다는 실례다.
 *
 * 돌려주는 `null` 과 `'unknown'` 은 다르다:
 *   · `null`    = herdr 가 **아무 말도 안 했다** (라벨도 규칙 id 도 없다 — 공백)
 *   · `unknown` = 말은 했는데 **갈래가 없다** (규칙이 두 뜻을 함께 받거나 처음 보는 문구)
 * 이 구분이 없으면 "출처에 없다" 와 "우리가 못 읽는다" 가 화면에서 같아진다.
 */
export function blockedReason(input: {
  labels?: Readonly<Record<string, string>> | null
  ruleId?: string | null
}): BlockedReason | null {
  const ruleId = input.ruleId ?? null
  if (ruleId !== null && ruleId.length > 0) {
    return BLOCKED_REASON_BY_RULE[ruleId] ?? 'unknown'
  }
  const labels = input.labels ?? null
  if (labels === null) return null
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
    /**
     * 값이 그대로면 시각·이력은 건드리지 않는다. 사유만 새로 알게 됐을 수 있어 그것만 받는다.
     *
     * **`null` 은 알던 사유를 지우지 않는다** (실측으로 잡은 결함): 사유가 실려 오는 곳은
     * `agent.explain` 뿐이고 스냅샷·재동기 봉투에는 `state_labels` 가 없다. 그래서 여기서
     * null 을 그대로 받으면 30초 재동기가 돌 때마다 explain 이 물어다 준 사유가 지워졌다 —
     * 저장소가 이름·상태·세션 참조에 이미 쓰는 규칙("키가 없으면 알던 값을 지킨다")과 같은
     * 자리이고, 같은 모양의 결함이다(H4 계열). 사유가 진짜 바뀌는 때는 **상태가 바뀔 때**이고
     * 그건 아래 전이 갈래가 처리한다.
     */
    const merged = blockedReason ?? previousState.blockedReason
    return merged === previousState.blockedReason ? previousState : { ...previousState, blockedReason: merged }
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

/** `agent.explain` 이 고른 규칙과, 우리가 사유로 쓰기로 한 규칙. */
type PickedRule = { ruleId: string | null; matchedRuleId: string | null; source: 'matched' | 'evaluated' | 'none' }

/**
 * `agent.explain` 응답에서 **사유로 쓸 규칙 하나**를 고른다 (S3 · F2).
 *
 * herdr 는 규칙을 우선순위로 정렬해 먼저 맞는 하나를 `matched_rule` 로 준다. 그런데 화면
 * 종류를 **안 가르는** 거친 규칙(`osc_title_blocked` 1300, `live_blocked_form` 980 …)이
 * 권한·질문 규칙보다 위에 있을 수 있고, 그러면 우리 사유가 늘 `unknown` 으로 수렴한다 —
 * 리뷰 R1 의 지적이다. 같은 응답에 `evaluated_rules` 가 이미 들어 있으므로 **요청은 그대로**
 * 두고 거기서 「맞았고(`matched:true`) 우리 표에 사유가 있는」 규칙을 찾는다.
 *
 * 고르는 순서는 **구체적인 것 우선**이다: `matched_rule` 이 이미 사유를 주면 그걸 쓰고,
 * 주지 못할 때만(`unknown` 으로 떨어질 때만) `evaluated_rules` 를 본다. 거친 규칙이 위에
 * 있어도 아래의 구체적 규칙이 같이 맞았다면 그 뜻이 더 정확하기 때문이다.
 * **아무 데서도 사유가 안 나오면 `matched_rule` 을 그대로 돌려준다** — 「말은 했는데 갈래가
 * 없다(`unknown`)」와 「아무 말도 없다(`null`)」의 구분을 여기서 뭉개지 않는다.
 */
export function pickBlockedRule(explain: Record<string, unknown> | null): PickedRule {
  if (explain === null) return { ruleId: null, matchedRuleId: null, source: 'none' }
  const matchedRuleId = readString(readRecord(explain, 'matched_rule') ?? {}, 'id')
  if (matchedRuleId !== null && blockedReason({ ruleId: matchedRuleId }) !== 'unknown') {
    return { ruleId: matchedRuleId, matchedRuleId, source: 'matched' }
  }
  for (const entry of readArray(explain, 'evaluated_rules')) {
    if (!isRecord(entry) || entry['matched'] !== true) continue
    const id = readString(entry, 'id')
    if (id === null) continue
    const reason = blockedReason({ ruleId: id })
    if (reason !== null && reason !== 'unknown') return { ruleId: id, matchedRuleId, source: 'evaluated' }
  }
  return { ruleId: matchedRuleId, matchedRuleId, source: matchedRuleId === null ? 'none' : 'matched' }
}
