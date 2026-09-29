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

/**
 * 닫기 요청이 **효과 없이 끝난 것이 확실한가**, 아니면 **결과를 모르는가** (R2-F3).
 *
 * 억제 표(누가 닫았나)를 언제 걷느냐가 여기 달렸다:
 *   · `refused` — 확정 거절. 전송 전에 막혔거나 서버가 **손대지 않고** 거절했다.
 *     표를 걷는다. 안 걷으면 나중에 그 pane 이 진짜로 끝났을 때 완료 기록이 삼켜진다
 *   · `unknown` — 전송은 됐는데 결과를 모른다(타임아웃·연결 끊김·취소·미관측).
 *     **표를 남긴다.** 닫힌 pane 이 되살아나는 쪽이, 완료 행 하나를 잃는 쪽보다 나쁘다
 *
 * **모르는 코드는 `unknown` 이다.** 라운드 1 은 GUI 가 `timeout` 만 불명으로 보고 나머지를
 * 전부 걷었고, CLI 는 **타임아웃까지 걷어** 둘이 반대로 판정했다(R2-F3, 3자 일치).
 * 새 코드가 생길 때 조용히 「걷는다」로 떨어지지 않게 기본값을 안전한 쪽에 둔다.
 *
 * CLI(`RuntimeError.code`)와 GUI(`HerdrRequestError.code`)가 **이 함수 하나**를 쓴다.
 */
export type CloseEffect = 'refused' | 'unknown'

/**
 * **확정 거절 집합** — 효과가 없다고 *말할 수 있는* 코드만 적는다 (R3-F1).
 *
 * 라운드 2 까지의 목록은 corral 쪽 코드만 보고 적어서, **herdr 가 실제로 닫기 경로에서
 * 내는 코드**가 빠져 있었다. 그래서 이번에는 herdr v0.9.0 소스에서 닫기 세 경로를 끝까지
 * 읽고, 「돌아가기 전에 아무것도 닫지 않은 것이 소스에서 보이는」 코드만 넣는다.
 * (읽은 트리: `/private/tmp/l456-r2-build/herdr-0.9.0`, `source.json` 의 v0.9.0 과 같은 것)
 *
 * corral 쪽 — 소켓에 나가기 전:
 *   · `method_not_allowed`  — corral 이 안 보내는 메서드. `request()` 가 연결 전에 던진다
 *     (`adapter/internal/request.ts:85`)
 * guard — 봉투를 까기 전 (`src/app/api/corral.rs`):
 *   · `stale_backend`(:20) · `deadline_exceeded`(:22, 메시지가 그대로 "no effect started")
 *   · `invalid_request`(:23·:51·:62) · `unsupported`(:48) · `stale_terminal`(:52·:54·:57)
 *   · `unsupported_backend` — corral 이 핸드셰이크에서 붙이는 이름(`terminal-backend.ts`)
 * herdr 닫기 경로 — 효과 **전에** 돌아간다:
 *   · `pane.close` → `close_pane` (`src/app/api/panes.rs:1852-1867`):
 *     `pane_not_found`, `confirmation_required`("closing this pane would close a worktree group")
 *   · `tab.close` → `handle_tab_close` (`src/app/api/tabs.rs:216-268`):
 *     `tab_not_found`, `confirmation_required`, `tab_close_failed`
 *     — `tab_close_failed` 는 `Workspace::close_tab` 이 `false` 를 준 것이고, 그 false 는
 *       `tabs.len() <= 1 || idx >= tabs.len()` 이라는 **이른 가드**뿐이라 부분 효과가 없다
 *       (`src/workspace.rs:579-582`)
 *   · `workspace.close` (`src/app/api/workspaces.rs:311-330`):
 *     `workspace_not_found`, `workspace_group_close_required`
 * 서버 파싱 (`src/api/server.rs:185`): `invalid_request`
 *
 * 나머지(`not_found`·`invalid_argument`)는 대상이 없어 할 일이 없었던 경우다.
 *
 * **`confirmation_required` 가 빠져 있던 것이 라운드 2 의 결함이다** — GUI 는 그 거절을
 * `rejected` 로 받아 `sent:false` 로 걷었고 CLI 는 코드 목록에 없어 남겼다. 같은 상황을
 * 반대로 판정했다.
 */
const CLOSE_REFUSED_CODES: readonly string[] = [
  'method_not_allowed', 'invalid_request', 'invalid_argument',
  'stale_terminal', 'stale_backend', 'deadline_exceeded',
  'unsupported', 'unsupported_backend',
  'not_found', 'tab_not_found', 'pane_not_found',
  'confirmation_required', 'tab_close_failed',
  'workspace_group_close_required', 'workspace_not_found',
]

/**
 * `sent` 는 **선택이 아니다** (R3-F1). 라운드 2 는 `sent?: boolean` 이라 호출부가 안 주면
 * 조용히 코드만으로 판정했고, GUI 는 반대로 늘 `false` 를 박아 서버 거절까지 「안 나갔다」로
 * 셌다. 둘 다 "하지 않은 일이 기대한 모양으로 통과" 하는 모양이라, 빠뜨리면 컴파일이
 * 멈추게 타입으로 막는다 — 값은 `request()` 의 `onSent`(바이트를 쓰기 직전)가 준다.
 */
export function closeEffect(input: { code?: string | null; sent: boolean }): CloseEffect {
  // 보내지도 못한 것은 효과가 없다 — 호출부가 그것을 아는 자리에서만 준다.
  if (!input.sent) return 'refused'
  const code = input.code ?? null
  if (code === null) return 'unknown'
  return CLOSE_REFUSED_CODES.includes(code) ? 'refused' : 'unknown'
}

/** `agent.explain` 이 고른 규칙과, 우리가 사유로 쓰기로 한 규칙. */
type PickedRule = {
  ruleId: string | null
  matchedRuleId: string | null
  source: 'matched' | 'evaluated' | 'none'
}

/**
 * 규칙 하나가 화면을 얼마나 **좁게** 집는가 (R2-F4).
 *
 * `evaluated_rules[].evidence` 가 그 규칙이 요구한 조건을 그대로 센다 — 문자열 포함 몇 개,
 * 정규식 몇 개, `any`/`all`/`not` 묶음 몇 개. **explain 응답이 직접 주는 값이라 매니페스트를
 * 따로 읽지 않는다.** 조건이 많을수록 그 규칙이 통과시키는 화면이 좁다.
 */
function conditionCount(entry: Record<string, unknown>): number {
  const evidence = readRecord(entry, 'evidence')
  if (evidence === null) return 0
  const lists = ['contains', 'line_regex', 'regex'] as const
  const counts = ['any_count', 'all_count', 'not_count'] as const
  let total = 0
  for (const key of lists) total += readArray(evidence, key).length
  for (const key of counts) {
    const raw = evidence[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) total += raw
  }
  return total
}

/**
 * `agent.explain` 응답에서 **사유로 쓸 규칙 하나**를 고른다 (S3 · F2 · R2-F4).
 *
 * herdr 는 규칙을 우선순위로 정렬해 먼저 맞는 하나를 `matched_rule` 로 준다. 그런데 화면
 * 종류를 **안 가르는** 거친 규칙(`osc_title_blocked` 1300, `live_blocked_form` 980 …)이
 * 권한·질문 규칙보다 위에 있을 수 있다. 같은 응답에 `evaluated_rules` 가 이미 들어 있으므로
 * **요청은 그대로** 두고 거기서 고른다.
 *
 * **「구체성 = priority 가 낮은 것」은 틀렸다** (R2-F4 — 라운드 1 의 전제를 실측이 깼다).
 * 방향이 화면마다 반대다:
 *   · claude 권한 — `bash_permission_prompt`(850)가 `generic_permission_prompt`(840)보다
 *     구체적인데 번호가 **높다**
 *   · grok 권한 — `permission_scope_selector`(1180)가 `option_dialog_blocked`(1200)보다
 *     구체적인데 번호가 **낮다**
 * herdr 에서 priority 는 「누가 이기나」이지 「얼마나 좁은가」가 아니다. 그래서 구체성은
 * **조건 개수**(`conditionCount`)로 재고, priority 는 **동점일 때의 승부**로만 쓴다 —
 * 그 자리에서는 herdr 자신의 규칙(높은 번호가 이긴다)을 그대로 빌린다.
 * 근거 표: `specs/LIFE-456-agent-state/raw/claude/s9-r2/00-f4-specificity.md`
 *
 * 고르는 절차:
 *   1. `matched === true` **그리고 `state === 'blocked'`** 인 규칙만 본다 — 같은 화면에서
 *      `osc_title_idle`·`live_prompt_box`·`osc_title_working` 도 함께 맞는다(실측). 그것들은
 *      다른 상태를 말하는 규칙이라 blocked 사유가 아니다
 *   2. 그중 **우리 표에 사유가 있는 것**만 후보다. `matched_rule` 도 **같은 자격으로** 넣는다 —
 *      거친 승자가 매핑돼 있다고 특권을 주지 않는다(R2-F4 의 요구: 매핑된 `option_dialog_blocked`
 *      가 이겨도 `permission_scope_selector` 가 있으면 그것을 쓴다)
 *   3. 조건수 최대 → priority 최대 → `matched_rule` → 배열 첫 번째 순으로 하나를 정한다.
 *      마지막 갈래는 **결정성 확보용**이지 구체성 판단이 아니다
 *
 * **후보가 없으면 `matched_rule` 을 그대로 돌려준다** — 「말은 했는데 갈래가 없다(`unknown`)」와
 * 「아무 말도 없다(`null`)」의 구분을 여기서 뭉개지 않는다.
 */
export function pickBlockedRule(explain: Record<string, unknown> | null): PickedRule {
  if (explain === null) return { ruleId: null, matchedRuleId: null, source: 'none' }
  const matchedRuleId = readString(readRecord(explain, 'matched_rule') ?? {}, 'id')

  type Candidate = { id: string; conditions: number; priority: number; order: number }
  const candidates: Candidate[] = []
  let order = 0
  for (const entry of readArray(explain, 'evaluated_rules')) {
    order += 1
    if (!isRecord(entry)) continue
    if (entry['matched'] !== true) continue
    if (readString(entry, 'state') !== 'blocked') continue
    const id = readString(entry, 'id')
    if (id === null) continue
    const reason = blockedReason({ ruleId: id })
    if (reason === null || reason === 'unknown') continue
    const rawPriority = entry['priority']
    candidates.push({
      id,
      conditions: conditionCount(entry),
      // 번호가 없으면 **가장 약한 승부값**을 준다 — 모르는 것을 세다고 우기지 않는다.
      priority: typeof rawPriority === 'number' && Number.isFinite(rawPriority) ? rawPriority : Number.NEGATIVE_INFINITY,
      order,
    })
  }

  let best: Candidate | null = null
  for (const item of candidates) {
    if (best === null || beats(item, best, matchedRuleId)) best = item
  }
  if (best !== null) {
    return { ruleId: best.id, matchedRuleId, source: best.id === matchedRuleId ? 'matched' : 'evaluated' }
  }
  return { ruleId: matchedRuleId, matchedRuleId, source: matchedRuleId === null ? 'none' : 'matched' }

  function beats(
    challenger: { id: string; conditions: number; priority: number; order: number },
    champion: { id: string; conditions: number; priority: number; order: number },
    matched: string | null,
  ): boolean {
    if (challenger.conditions !== champion.conditions) return challenger.conditions > champion.conditions
    if (challenger.priority !== champion.priority) return challenger.priority > champion.priority
    if (challenger.id === matched) return true
    if (champion.id === matched) return false
    return challenger.order < champion.order
  }
}
