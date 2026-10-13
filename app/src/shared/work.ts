// 작업 계약 (LIFE-600 · LIFE-372 묶음 T1) — 화면·IPC·main 이 같이 보는 「작업 출처(work source)」 어휘.
//
// - 「provider」 는 이미 에이전트 CLI(claude·codex·grok)를 뜻한다(`types.ts` AgentKind) — 작업 쪽은 「출처(source)」 라 부른다.
// - 개념: 연결(Connection, 토큰 하나) → 스페이스(Space, 1급) → 작업(Item). 03-feature-plan §1·§8.1.
// - **키·id 는 모두 불투명 문자열이다** — 화면은 형식을 해석하지 않는다(§8.1 규칙 3). `key` 는 사람이 읽는 키(LIFE-372 · CORE-12),
//   `id` 는 연산에 쓰는 출처 내부 식별자다. 둘 다 출처가 정하고 화면은 그대로 그린다.
// - 출처 차이는 **능력 표**로만 드러낸다: 구조적으로 못 하면 `hidden`, 지금만 못 하면 `disabled` + 이유(design-handoff Q3).
// - 화면은 출처 이름으로 분기하지 않는다(P2) — 표시 이름·글자 아이콘·토큰 칸 문구는 main 이 준 `WorkSourceDescriptor` 를 그린다.
// - 토큰 원문은 이 파일의 어떤 모양에도 없다 — 밖으로 나가는 것은 끝 4자(`tokenTail`)뿐이다(D4).

import { isRecord } from './json.js'

export const WORK_CATEGORIES = ['todo', 'in_progress', 'done'] as const
export type WorkCategory = (typeof WORK_CATEGORIES)[number]

/** 연결 5종 — 방향 있는 쌍(막힘 ↔ 막음, 중복 ↔ 중복됨, 관련 ↔ 관련). 화면 순서도 이 순서다(handoff 「연결 묶음」). */
export const WORK_RELATION_KINDS = ['is_blocked_by', 'blocks', 'duplicates', 'is_duplicated_by', 'relates_to'] as const
export type WorkRelationKind = (typeof WORK_RELATION_KINDS)[number]

export const WORK_PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'] as const
export type WorkPriority = (typeof WORK_PRIORITIES)[number]

export type WorkPlacement = 'board' | 'backlog'

/** 능력 하나 — 켜짐 · 숨김(구조적으로 없음) · 흐림(지금은 불가, 이유를 보인다). */
export type WorkCapability = { state: 'on' } | { state: 'hidden' } | { state: 'disabled'; reason: string }

/** 상태 변경 방식 — `any` 는 아무 상태로(LA), `allowed` 는 `listTransitions` 가 준 상태로만(Jira). */
export type WorkTransitionMode = { mode: 'any' } | { mode: 'allowed' }

export type WorkCapabilities = {
  transition: WorkTransitionMode
  /** 보드 / 백로그 배치. */
  placement: WorkCapability
  relations: WorkCapability
  parentChange: WorkCapability
  /** 순서(rank) — 세로 끌기. */
  order: WorkCapability
  /** 목록 커서 페이지. 꺼져 있으면 `listItems` 는 한 번에 다 주고, 상한에 걸렸으면 `truncated` 로 알린다. */
  cursorPaging: WorkCapability
  /** 조건부 수정(`ifVersion`) — 꺼져 있으면 저장 충돌을 검사하지 못한다. */
  conflictCheck: WorkCapability
  comments: WorkCapability
  /** 작업 링크(worktree·브랜치·PR·세션)를 출처 쪽에 저장. */
  workLinkStore: WorkCapability
}

export type WorkCapabilityName = Exclude<keyof WorkCapabilities, 'transition'>

export type WorkSpace = {
  key: string
  name: string
  /** 출처가 준 색(LA 프로젝트 색). 없으면 null — 화면이 `--space-N` 을 순서대로 쓴다. */
  color: string | null
  description: string | null
  /** 열린(완료 분류가 아닌) 작업 수. 출처가 셀 수 없으면 null. */
  openCount: number | null
  /** `catch_all` = 어느 스페이스에도 속하지 않는 작업을 모으는 자리(LA 「미분류」). */
  role: 'regular' | 'catch_all'
}

export type WorkStatus = {
  key: string
  label: string
  category: WorkCategory
  /** 워크플로 순서(작을수록 앞). 같은 스페이스 안에서만 의미가 있다. */
  order: number
  color: string | null
}

export type WorkKind = { key: string; label: string }

export type WorkItemRef = {
  id: string
  key: string
  title: string
  statusLabel: string
  category: WorkCategory
}

export type WorkRelation = {
  id: string
  kind: WorkRelationKind
  other: WorkItemRef
}

/** 작업 링크 — T5 가 채운다. T1 은 모양만(계약 자리). */
export type WorkLink =
  | { kind: 'worktree'; path: string; repoRoot: string | null }
  | { kind: 'branch'; name: string; repoRoot: string | null }
  | { kind: 'pull_request'; url: string; state: 'open' | 'merged' | 'closed' | null }
  | { kind: 'agent_session'; sessionId: string; agent: string | null }

export type WorkItem = {
  id: string
  key: string
  spaceKey: string
  title: string
  /** 본문(markdown). 목록에서는 null(가벼움) — 단건(`getItem`)에서만 채운다. */
  body: string | null
  kind: WorkKind
  statusKey: string
  category: WorkCategory
  priority: WorkPriority | null
  dueAt: string | null
  /** 같은 스페이스 안의 부모. 스페이스 바로 아래면 null(§8.1 규칙 2). */
  parentId: string | null
  placement: WorkPlacement | null
  /** 순서 값 — 불투명. 순서 능력이 꺼진 출처도 정렬용으로 줄 수 있다. */
  rank: string | null
  openBlockerCount: number
  updatedAt: string
  /** 조건부 수정용 판(`ifVersion`). 충돌 검사 능력이 꺼져 있으면 null. */
  version: string | null
  /** 연결 — 단건에서만 채운다(목록은 null). */
  relations: WorkRelation[] | null
  workLinks: WorkLink[]
}

export type WorkComment = { id: string; author: string | null; body: string; createdAt: string }

/** 출처에 보내는 연산 하나 — 연결·요청 id 는 바깥 봉투(`WorkRequest`)가 든다. */
export type WorkCall =
  | { op: 'listSpaces' }
  | { op: 'listStatuses'; spaceKey: string }
  | { op: 'listItems'; spaceKey: string; cursor: string | null }
  | { op: 'getItem'; itemId: string }
  | { op: 'listTransitions'; itemId: string }
  | { op: 'changeStatus'; itemId: string; statusKey: string; ifVersion: string | null }
  | { op: 'setPlacement'; itemId: string; placement: WorkPlacement; ifVersion: string | null }
  | { op: 'setParent'; itemId: string; spaceKey: string; parentId: string | null; ifVersion: string | null }
  | { op: 'reorder'; itemId: string; afterId: string | null }
  | { op: 'addRelation'; itemId: string; kind: WorkRelationKind; otherKey: string }
  | { op: 'removeRelation'; itemId: string; relationId: string }
  | { op: 'listComments'; itemId: string }
  | { op: 'addComment'; itemId: string; body: string }

export type WorkOp = WorkCall['op']

export type WorkResult =
  | { op: 'listSpaces'; spaces: WorkSpace[]; capabilities: WorkCapabilities }
  | { op: 'listStatuses'; statuses: WorkStatus[]; kinds: WorkKind[] }
  | { op: 'listItems'; items: WorkItem[]; nextCursor: string | null; truncated: boolean }
  | { op: 'getItem'; item: WorkItem }
  | { op: 'listTransitions'; statusKeys: string[] }
  | { op: 'changeStatus' | 'setPlacement' | 'setParent' | 'reorder'; item: WorkItem }
  | { op: 'addRelation'; relation: WorkRelation }
  | { op: 'removeRelation'; relationId: string }
  | { op: 'listComments'; comments: WorkComment[] }
  | { op: 'addComment'; comment: WorkComment }

/**
 * 오류 분류. 연결 상태를 바꾸는 것은 앞의 다섯(K2): 인증 실패 · 권한 부족 · 네트워크(연결 실패·DNS·시간 초과·5xx) · 키체인 · 저장 충돌.
 * 나머지는 연산 하나의 실패다 — 응답 모양 어긋남(main 검증) · 출처가 거절(검증 실패·없는 키) · 능력 꺼짐 · 잘못된 요청 · 연결 없음 · 로컬 저장 실패.
 */
export type WorkErrorKind =
  | 'auth'
  | 'forbidden'
  | 'network'
  | 'keychain'
  | 'conflict'
  | 'invalid_response'
  | 'rejected'
  | 'unsupported'
  | 'invalid_request'
  | 'not_connected'
  | 'local_write'

export type WorkError = {
  kind: WorkErrorKind
  /** 화면에 그대로 보일 한 줄(한국어). 토큰은 들어가지 않는다. */
  message: string
  /** HTTP 상태 — 있을 때만. */
  status: number | null
}

/** 렌더러 → main 봉투. `requestId` 는 늦은 응답 폐기용 — main 은 그대로 돌려준다(소비는 T2). */
export type WorkRequest = { requestId: string; connectionId: string; call: WorkCall }

export type WorkResponse =
  | { requestId: string; connectionId: string; ok: true; result: WorkResult }
  | { requestId: string; connectionId: string; ok: false; error: WorkError }

/** 연결 카드 pill 값 — `data-connection-status`. `unchecked` = 이번 실행에서 아직 안 읽음(자격은 필요할 때만 푼다). */
export type WorkConnectionStatus = 'unchecked' | 'testing' | 'ok' | 'auth' | 'forbidden' | 'offline' | 'keychain'

/** 확인 중일 때 무엇을 기다리나 — 키체인이면 화면이 「macOS 가 허용을 물을 수 있다」 를 보인다. */
export type WorkConnectionPending = 'keychain' | 'network' | null

/** 출처 하나의 표시 정보 — 화면은 이것만 그린다(출처 이름으로 분기하지 않는다). */
export type WorkSourceDescriptor = {
  id: string
  name: string
  /** 카드 아이콘 자리 글자(LA · J). */
  mono: string
  addLabel: string
  formTitle: string
  tokenLabel: string
  /** 토큰이 이 접두사로 시작해야 한다 — 화면은 보내기 전에, main 은 네트워크 전에 다시 거절한다. 없으면 null. */
  tokenPrefix: string | null
}

export type WorkSpaceToggle = { key: string; name: string; color: string | null; openCount: number | null; hidden: boolean }

export type WorkConnectionSummary = {
  id: string
  sourceId: string
  name: string
  mono: string
  tokenTail: string
  addedAt: number
  status: WorkConnectionStatus
  pending: WorkConnectionPending
  /** 마지막 오류 — 상태가 오류 계열일 때만. `replace_token` 은 인증 실패·키체인일 때(토큰 다시 붙여넣기). */
  error: { message: string; action: 'replace_token' | 'retry' | null } | null
  checkedAt: number | null
  /** 마지막으로 받은 스페이스 목록 + 숨김. 이번 실행에서 아직 못 받았으면 null. */
  spaces: WorkSpaceToggle[] | null
  hiddenSpaceKeys: string[]
  capabilities: WorkCapabilities | null
}

export type WorkRepoDefault = { repoRoot: string; connectionId: string; spaceKey: string }

export type WorkSettingsState = {
  sources: WorkSourceDescriptor[]
  connections: WorkConnectionSummary[]
  repoDefaults: WorkRepoDefault[]
}

export type WorkConnectionAddInput = { sourceId: string; token: string; replaceId: string | null }
export type WorkConnectionAddResult = { ok: true; connection: WorkConnectionSummary } | { ok: false; error: WorkError }
export type WorkActionResult = { ok: true } | { ok: false; error: WorkError }

/** 오류 → 연결 상태. 연결 상태를 바꾸지 않는 오류는 null. */
export function connectionStatusOf(kind: WorkErrorKind): WorkConnectionStatus | null {
  switch (kind) {
    case 'auth': return 'auth'
    case 'forbidden': return 'forbidden'
    case 'network': return 'offline'
    case 'keychain': return 'keychain'
    case 'conflict':
    case 'invalid_response':
    case 'rejected':
    case 'unsupported':
    case 'invalid_request':
    case 'not_connected':
    case 'local_write':
      return null
  }
}

/** 연산이 기대는 능력 — 없으면 null(늘 켜짐). `listItems` 의 커서·`ifVersion` 은 값이 있을 때만 능력을 본다. */
export function capabilityOf(call: WorkCall): WorkCapabilityName | null {
  switch (call.op) {
    case 'listSpaces':
    case 'listStatuses':
    case 'getItem':
    case 'listTransitions':
      return null
    case 'listItems':
      return call.cursor === null ? null : 'cursorPaging'
    case 'changeStatus':
      return call.ifVersion === null ? null : 'conflictCheck'
    case 'setPlacement':
      return 'placement'
    case 'setParent':
      return 'parentChange'
    case 'reorder':
      return 'order'
    case 'addRelation':
    case 'removeRelation':
      return 'relations'
    case 'listComments':
    case 'addComment':
      return 'comments'
  }
}

/** `setPlacement`·`setParent` 는 자기 능력 + (판이 있으면) 충돌 검사 둘을 본다. */
export function capabilitiesOf(call: WorkCall): WorkCapabilityName[] {
  const own = capabilityOf(call)
  const list: WorkCapabilityName[] = own === null ? [] : [own]
  if ((call.op === 'setPlacement' || call.op === 'setParent') && call.ifVersion !== null) list.push('conflictCheck')
  return list
}

// --- 렌더러 → main 입력 손검증 (unknown → 계약 타입). `card-actions.ts` 선례: 모르는 모양은 null. ---

const isString = (value: unknown): value is string => typeof value === 'string'
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512

function pick<T extends string>(list: readonly T[], value: unknown): T | null {
  return list.find((entry) => entry === value) ?? null
}

export function readWorkCategory(value: unknown): WorkCategory | null {
  return pick(WORK_CATEGORIES, value)
}

export function readWorkRelationKind(value: unknown): WorkRelationKind | null {
  return pick(WORK_RELATION_KINDS, value)
}

export function readWorkPriority(value: unknown): WorkPriority | null {
  return pick(WORK_PRIORITIES, value)
}

function readPlacement(value: unknown): WorkPlacement | null {
  return value === 'board' || value === 'backlog' ? value : null
}

export function readWorkCall(value: unknown): WorkCall | null {
  if (!isRecord(value)) return null
  const op = value.op
  const itemId = value.itemId
  const ifVersion = value.ifVersion ?? null
  switch (op) {
    case 'listSpaces':
      return { op }
    case 'listStatuses':
      return isNonEmpty(value.spaceKey) ? { op, spaceKey: value.spaceKey } : null
    case 'listItems': {
      const cursor = value.cursor ?? null
      return isNonEmpty(value.spaceKey) && isNullableString(cursor) ? { op, spaceKey: value.spaceKey, cursor } : null
    }
    case 'getItem':
    case 'listTransitions':
    case 'listComments':
      return isNonEmpty(itemId) ? { op, itemId } : null
    case 'changeStatus':
      return isNonEmpty(itemId) && isNonEmpty(value.statusKey) && isNullableString(ifVersion) ? { op, itemId, statusKey: value.statusKey, ifVersion } : null
    case 'setPlacement': {
      const placement = readPlacement(value.placement)
      return isNonEmpty(itemId) && placement !== null && isNullableString(ifVersion) ? { op, itemId, placement, ifVersion } : null
    }
    case 'setParent': {
      const parentId = value.parentId ?? null
      return isNonEmpty(itemId) && isNonEmpty(value.spaceKey) && (parentId === null || isNonEmpty(parentId)) && isNullableString(ifVersion)
        ? { op, itemId, spaceKey: value.spaceKey, parentId, ifVersion }
        : null
    }
    case 'reorder': {
      const afterId = value.afterId ?? null
      return isNonEmpty(itemId) && (afterId === null || isNonEmpty(afterId)) ? { op, itemId, afterId } : null
    }
    case 'addRelation': {
      const kind = readWorkRelationKind(value.kind)
      return isNonEmpty(itemId) && kind !== null && isNonEmpty(value.otherKey) ? { op, itemId, kind, otherKey: value.otherKey } : null
    }
    case 'removeRelation':
      return isNonEmpty(itemId) && isNonEmpty(value.relationId) ? { op, itemId, relationId: value.relationId } : null
    case 'addComment':
      return isNonEmpty(itemId) && isString(value.body) && value.body.length > 0 && value.body.length <= 65_536 ? { op, itemId, body: value.body } : null
    default:
      return null
  }
}

export function readWorkRequest(value: unknown): WorkRequest | null {
  if (!isRecord(value) || !isNonEmpty(value.requestId) || !isNonEmpty(value.connectionId)) return null
  const call = readWorkCall(value.call)
  return call === null ? null : { requestId: value.requestId, connectionId: value.connectionId, call }
}
