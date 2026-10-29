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
  /** 변경 이력(E8 · LIFE-602) — 코멘트와 별개다(Jira 는 둘 다, LA 는 L1e 뒤). 꺼져 있으면 활동은 corral 기록·코멘트만. */
  history: WorkCapability
  /** 작업 링크(worktree·브랜치·PR·세션)를 출처 쪽에 저장. */
  workLinkStore: WorkCapability
  /**
   * 완료 갈래 고르기(E5 · LIFE-605) — 꺼져 있으면 완료 분류로 갈 때 「완료함/취소함」 을 고르지 못한다(출처가 정한 해결 값을 읽기만 한다).
   * 화면은 완료 상태를 한 줄로 그리고 갈래를 싣지 않는다 · main 은 갈래를 실은 상태 변경을 출처에 닿기 전에 막는다.
   */
  resolution: WorkCapability
  /** 질의 검색(LIFE-605 C5) — 검색어가 descriptor `queryPattern` 모양이면 출처 질의(Jira JQL)로 찾는다. 꺼져 있으면 화면은 받은 목록을 글로 거른다. */
  querySearch: WorkCapability
}

/**
 * 스페이스별 능력 (LIFE-605 C7 · F10) — 연결 능력이 켜져 있어도 스페이스마다 못 할 수 있다(Jira: 보드·Rank 는 Jira Software · 프로젝트의 보드).
 * 칸이 없으면 연결 능력 그대로. **좁히기만 한다** — 연결에서 꺼진 능력을 스페이스가 켜지 못한다(`spaceCapabilities`).
 */
export type WorkSpaceCapabilities = { order?: WorkCapability; placement?: WorkCapability }

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
  /** 이 스페이스에서만 다른 능력(LIFE-605 C7). 빈 객체 = 연결 능력 그대로. */
  capabilities: WorkSpaceCapabilities
}

/** 스페이스에서 실제로 쓰는 능력 — 연결에서 켜진 능력만 스페이스 칸이 좁힌다. 화면·main 이 같은 규칙을 쓴다. */
export function spaceCapabilities({ capabilities, space }: { capabilities: WorkCapabilities; space: { capabilities: WorkSpaceCapabilities } | null }): WorkCapabilities {
  if (space === null) return capabilities
  const narrow = (base: WorkCapability, own: WorkCapability | undefined): WorkCapability => (base.state !== 'on' || own === undefined ? base : own)
  return { ...capabilities, order: narrow(capabilities.order, space.capabilities.order), placement: narrow(capabilities.placement, space.capabilities.placement) }
}

export type WorkStatus = {
  key: string
  label: string
  category: WorkCategory
  /** 워크플로 순서(작을수록 앞). 같은 스페이스 안에서만 의미가 있다. */
  order: number
  color: string | null
}

/**
 * 종류 — `childKinds` 는 이 종류 아래에 만들 수 있는 자식 종류 키(E6 · LIFE-602). 비면 자식을 만들 수 없다(「+ 자식 추가」 를 그리지 않는다).
 * 출처의 부모 규칙(LA: task 는 잎, bug 아래에는 task 만)을 출처가 알려 준다 — 화면은 출처 이름으로 분기하지 않는다.
 */
export type WorkKind = { key: string; label: string; childKinds: string[] }

/** 완료 갈래(E5 · LIFE-602) — 완료 분류 작업이 「완료함」 인가 「취소함」 인가. `other` = 출처의 다른 값(LA archived·duplicate) — 어느 쪽으로도 꾸미지 않는다. */
export const WORK_RESOLUTIONS = ['completed', 'cancelled'] as const
export type WorkResolutionChoice = (typeof WORK_RESOLUTIONS)[number]
export type WorkResolution = WorkResolutionChoice | 'other'

export type WorkItemRef = {
  id: string
  key: string
  title: string
  statusLabel: string
  category: WorkCategory
  /** 상대의 스페이스(E9 · LIFE-602) — 모르면 null(화면은 표기하지 않는다). */
  spaceKey: string | null
}

/** 열린 막은 쪽 하나 (E1 · LIFE-601) — 목록 카드의 막힘 배지 「막힘 · KEY (외 N)」 에 쓴다. 열린 = 완료 분류가 아님(출처가 거른다). */
export type WorkBlockerRef = { id: string; key: string; title: string }

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

/**
 * 출처에 저장된 작업 링크 한 행(LIFE-635 L1a — LA `IssueWorkLinkResponse`). 판별 = 종류 + 핵심 값 + `machine` — 같은 경로라도 machine 이 다르면 다른 행이다.
 * `machine` = 링크를 남긴 기기 이름(corral 은 이 Mac 의 고정 이름을 싣는다) · `repo` = 레포 표시 이름 · `createdAt` = 출처가 처음 저장한 시각(ISO).
 * 출처가 모르는 값은 null.
 */
export type WorkLinkRecord = { link: WorkLink; machine: string | null; repo: string | null; createdAt: string | null }

export type WorkItem = {
  id: string
  key: string
  spaceKey: string
  title: string
  /**
   * 본문(markdown). **단건 모양**(`getItem`·`findByKey`·쓰기 결과 — `WorkResult` 참고)에서는 정본이다: null = 출처의 빈 본문(LA `description:null`)이지 「안 실음」 이 아니다.
   * **목록 모양**(`listItems`·`listChildren`·`searchItems`)의 null 은 「안 실음」(가벼움). 어느 모양인지는 연산이 정한다 — 목록 행의 null 을 정본으로 쓰지 않는다(LIFE-623).
   */
  body: string | null
  kind: WorkKind
  statusKey: string
  category: WorkCategory
  /** 완료 갈래(E5). 완료 분류가 아니거나 출처가 값을 주지 않으면 null. */
  resolution: WorkResolution | null
  /**
   * done 분류에 들어간 시각(ISO, LIFE-702) — 보드·백로그의 오래된 완료 숨김 판정과 상세 「완료」 행(LIFE-711)에 쓴다. 출처가 주지 않으면 null(숨기지 않음).
   * LA 는 응답 값 그대로(칸이 없으면 null), Jira 는 done 분류일 때 `statuscategorychangedate`(칸이 없거나 해석 안 되면 null).
   */
  doneAt: string | null
  priority: WorkPriority | null
  dueAt: string | null
  /** 같은 스페이스 안의 부모. 스페이스 바로 아래면 null(§8.1 규칙 2). */
  parentId: string | null
  placement: WorkPlacement | null
  /** 순서 값 — 불투명. 순서 능력이 꺼진 출처도 정렬용으로 줄 수 있다. */
  rank: string | null
  openBlockerCount: number
  /** 열린 막은 쪽 참조 (E1) — 목록·단건 모두 채운다. 길이 = `openBlockerCount`. */
  openBlockers: WorkBlockerRef[]
  updatedAt: string
  /** 조건부 수정용 판(`ifVersion`). 충돌 검사 능력이 꺼져 있으면 null. */
  version: string | null
  /** 연결 — 단건 모양에서는 정본(빈 연결 = 빈 배열), 목록 모양에서는 null(안 실음). 모양 규칙은 `body` 와 같다. */
  relations: WorkRelation[] | null
  /**
   * 출처에 저장된 작업 링크(LIFE-635 C1) — **단건 모양에서만 정본**이다. 목록 모양의 빈 배열은 「안 실음」 이지 「없음」 이 아니다
   * (LA `issue_list` 행에는 링크가 없다 — LIFE-609 D2). 목록 행의 빈 배열로 「링크 없음」 을 그리지 않는다.
   */
  workLinks: WorkLinkRecord[]
  /**
   * 본문 편집 잠금(LIFE-605 C6) — 출처 본문에 markdown 으로 바꿀 수 없는 요소(Jira 멘션·패널·표 …)가 있으면 그 이유 글. 화면은 **편집을 열기 전에** 보이고
   * 본문 편집을 막는다(저장이 그 요소를 조용히 지우지 않게). 체크 칸 바로 저장은 열어 둔다 — 출처가 그 칸 상태만 바꾼다. 없으면 null(목록 행도 null).
   */
  bodyLock: string | null
  /** 본문을 고쳐 저장하면 바뀌는 모양의 안내(LIFE-605 R4-B — Jira 의 빈 문단 간격). 화면은 편집하는 동안 보인다. 없으면 바뀌는 것이 없다. */
  bodySaveNote?: string
}

export type WorkComment = { id: string; author: string | null; body: string; createdAt: string }

/** 필드 부분 수정(E4 · LIFE-602) — 보낸 칸만 바꾼다. `dueAt` 은 ISO(UTC) 또는 null(지움). */
export type WorkFieldPatch = { title?: string; body?: string; priority?: WorkPriority | null; dueAt?: string | null }

/** 이력에 나오는 칸 — 출처 이력(E8)과 corral 활동 기록이 같이 쓴다. */
export const WORK_HISTORY_FIELDS = ['status', 'title', 'body', 'priority', 'dueAt', 'placement', 'parent', 'relation', 'child'] as const
export type WorkHistoryField = (typeof WORK_HISTORY_FIELDS)[number]

/**
 * 출처 변경 이력 한 줄(E8). `from`·`to` 는 사람이 읽는 값(출처가 정한 글) — 화면은 그대로 그린다.
 * `writeId` = 그 변경을 낸 쓰기가 출처에 실어 보낸 corral 쓰기 id(Jira `historyMetadata` 류) — corral 활동 기록과 같은 변경을 한 번만 보이는 데 쓴다.
 * corral 이 아닌 곳(웹·다른 클라이언트)에서 한 변경은 null 이다 — 같은 칸·같은 값이어도 지우지 않는다(G10).
 */
export type WorkHistoryEntry = { id: string; at: string; author: string | null; field: WorkHistoryField; from: string | null; to: string | null; writeId: string | null }

/**
 * corral 활동 기록 한 줄(D9 · LIFE-602) — main 이 성공한 쓰기마다 남긴다(`activity-store.ts`). 「누가」 는 늘 「나 · corral」.
 * `writeId` 는 출처 이력의 같은 칸과 짝을 짓는 열쇠다.
 */
export type WorkActivityChange =
  | { field: 'status'; statusKey: string; statusLabel: string | null; resolution: WorkResolution | null }
  | { field: 'title'; to: string }
  | { field: 'body'; lines: number }
  | { field: 'priority'; to: WorkPriority | null }
  | { field: 'dueAt'; to: string | null }
  | { field: 'placement'; to: WorkPlacement }
  | { field: 'parent'; parentId: string | null }
  | { field: 'relation'; action: 'add' | 'remove'; kind: WorkRelationKind | null; otherKey: string | null }
  | { field: 'child'; childKey: string; childTitle: string }
  /** 만들었음(LIFE-604 C10) — 새 작업 자신에 한 줄. 부모의 `child` 줄과 별개다. */
  | { field: 'created'; kindLabel: string }
  /** 실행 갈래(LIFE-603 C13) — 작업 시작 · 자동 연결 · 떼기. `worktree` 는 경로, `branch` 는 그때의 브랜치 이름. */
  | { field: 'run'; event: 'start'; worktree: string; branch: string; agent: string; model: string | null }
  | { field: 'run'; event: 'auto_link' | 'detach'; worktree: string; branch: string | null }
  /** LIFE-603 R1-I — 자동 연결을 출처에 저장하지 못했다(로컬 링크는 그대로). */
  | { field: 'run'; event: 'source_link_failed'; worktree: string; message: string | null }
  /**
   * 에이전트 갈래(LIFE-603 C13) — 링크된 worktree 의 에이전트 사건. `question` 은 질문 본문(못 읽는 에이전트는 null + `noBody` 이유),
   * `result` 는 턴 결과(완료 · 중단 · 실패)와 그때 바뀐 파일 수(git 상태, 모르면 null).
   */
  | { field: 'agent'; event: 'question'; agent: string | null; worktree: string; question: string | null; noBody: string | null }
  | { field: 'agent'; event: 'result'; agent: string | null; worktree: string; outcome: 'completed' | 'interrupted' | 'failed'; detail: string | null; filesChanged: number | null }

/**
 * `itemKey` — 작업 id 를 모르는 기록(자동 연결된 worktree 의 사건)은 키로 찾는다(LIFE-603). 그때 `itemId` 는 빈 문자열이다.
 * `eventKey` — 같은 사건을 한 번만 남기는 열쇠(LIFE-603 C13 — 재시작 · 재방송 · 재관측에 중복 0). 쓰기 기록(LIFE-602)에는 없다.
 */
export type WorkActivityRecord = { id: string; connectionId: string; itemId: string; at: number; writeId: string; change: WorkActivityChange; itemKey?: string; eventKey?: string }

export type WorkActivityQuery = { connectionId: string; itemId: string; itemKey?: string }
export type WorkActivityResult = { ok: true; records: WorkActivityRecord[] } | { ok: false; error: WorkError }

/** 저장 충돌(E7) — 서버의 지금 작업과, 아는 경우 마지막으로 바꾼 쪽. 화면은 연 시점 값과 칸별로 비교해 「어떤 칸」 을 계산한다. */
export type WorkConflict = { current: WorkItem; by: string | null }

/**
 * 생성 메타의 필수 필드 하나(E11 · LIFE-604). corral 이 채울 수 있는 값 모양은 좁다 — 글(`text`)·고르기 하나(`option`).
 * 그 밖 모양(사람·여러 개 고르기·날짜 …)은 `unsupported` 로 내려 화면이 「corral 에서 채울 수 없음」 을 보이고 만들기를 막는다(빈 값 전송 금지).
 * 메타에 실린 필드는 전부 **필수**다 — 선택 필드는 싣지 않는다.
 */
export type WorkCreateField =
  | { key: string; label: string; shape: 'text' }
  | { key: string; label: string; shape: 'option'; options: { id: string; label: string }[] }
  | { key: string; label: string; shape: 'unsupported'; sourceType: string }

/** 필수 필드 값 — `text` 면 글, `option` 이면 고른 `options[].id`. */
export type WorkCreateFieldValue = { key: string; value: string }

/**
 * 생성 메타(E11) — `statusKeys` = 만들 때 고를 수 있는 상태(완료 분류 제외, 출처가 첫 상태만 받으면 하나), `defaultStatusKey` 는 그 안.
 * `placement` = 이 (스페이스, 종류)에 보드/백로그 배치가 적용되는가(LIFE-604 R2-H) — `ignored` 면 화면은 배치 칩을 흐리고 `placement` 를 싣지 않는다
 * (실어 보내면 출처가 거절 — 받는 척 금지). 예: Jira 는 종류 무관 `ignored`. LA 는 task·checkpoint·bug 모두 `applies`(LA LIFE-293 — LIFE-665).
 * `unavailable` = 이 (스페이스, 종류)로는 만들 수 없다 — 이유 글(LIFE-604 R4-F). 화면은 그 종류를 흐림 + 이유로 두고, 출처는 만들기를 거절한다.
 * 예: LA 「미분류」 의 Checkpoint(부모 프로젝트 필수). 없으면 만들 수 있다.
 */
/**
 * `accepts` (LIFE-605 · T4 §14-1) = 이 종류가 만들 때 받는 계약 칸 — Jira 는 종류마다 만들기 화면에 본문(description)·우선순위가 없을 수 있다.
 * 받지 않는 칸은 화면이 흐리고 싣지 않는다 · 실으면 출처가 거절한다(`createFieldsProblem`, 받는 척 금지).
 */
export type WorkCreateAccepts = { body: boolean; priority: boolean }

export type WorkCreateMeta = { spaceKey: string; kindKey: string; statusKeys: string[]; defaultStatusKey: string; placement: 'applies' | 'ignored'; accepts: WorkCreateAccepts; fields: WorkCreateField[]; unavailable?: string }

/** 필수 필드 상한 — 값 하나의 길이·필드 수. */
export const WORK_CREATE_FIELD_VALUE_MAX = 10_000
export const WORK_CREATE_FIELDS_MAX = 50

/** 출처에 보내는 연산 하나 — 연결·요청 id 는 바깥 봉투(`WorkRequest`)가 든다. */
export type WorkCall =
  | { op: 'listSpaces' }
  | { op: 'listStatuses'; spaceKey: string }
  | { op: 'listItems'; spaceKey: string; cursor: string | null }
  | { op: 'getItem'; itemId: string }
  /** 키로 작업 하나 찾기 (E2 · LIFE-601) — 스페이스 무관. 키 모양 판별은 화면이 descriptor 의 `keyPattern` 으로만 한다. */
  | { op: 'findByKey'; key: string }
  | { op: 'listTransitions'; itemId: string }
  /** `resolution` — 완료 분류로 갈 때의 갈래(E5). null 이면 출처 기본(완료함). 완료 분류가 아닌 상태로 가면 무시한다. 같은 상태에 다른 갈래면 갈래만 바꾼다. */
  | { op: 'changeStatus'; itemId: string; statusKey: string; ifVersion: string | null; resolution?: WorkResolutionChoice | null }
  /** 필드 부분 수정(E4) — 제목·본문·우선순위·마감. */
  | { op: 'updateItem'; itemId: string; fields: WorkFieldPatch; ifVersion: string | null }
  /** 자식 목록(E6) — 이 작업을 부모로 둔 미보관 작업. */
  | { op: 'listChildren'; itemId: string }
  /**
   * 작업 만들기(E6 · E10 LIFE-604) — 제목·종류·부모는 늘, 나머지 칸은 **보낸 것만**(없으면 출처 기본).
   * `parentId` null = 스페이스 바로 아래. 부모 종류의 `childKinds` 밖이면 출처가 거절한다.
   * `statusKey` 는 생성 메타(`getCreateMeta`)의 `statusKeys` 안이어야 하고, `fields` 는 메타의 필수 필드 값이다 —
   * 메타 밖의 상태·필드, 빠진 필수 필드는 출처가 거절한다(조용히 버리지 않는다). `placement` 를 보내면 배치 능력이 켜져 있어야 한다.
   */
  | { op: 'createItem'; spaceKey: string; parentId: string | null; kindKey: string; title: string; body?: string; statusKey?: string; priority?: WorkPriority | null; placement?: WorkPlacement; fields?: WorkCreateFieldValue[] }
  /** 생성 메타(E11 · LIFE-604) — (스페이스, 종류) 로 만들 수 있는 상태·기본 상태·필수 필드. 종류마다 다르다(Jira createmeta). */
  | { op: 'getCreateMeta'; spaceKey: string; kindKey: string }
  /** 변경 이력(E8) — 오래된 것부터. */
  | { op: 'listHistory'; itemId: string }
  /**
   * 질의 검색(LIFE-605 C5) — 능력 `querySearch`. `query` 는 사용자가 친 글 그대로. 출처가 질의로 보내고, 출처가 그 질의를 거부하면 **텍스트 검색으로 다시 찾고**
   * 거부 사유를 `note` 로 돌려준다(화면이 필터 줄에 보인다). `spaceKeys` 안에서만 찾는다.
   */
  | { op: 'searchItems'; spaceKeys: string[]; query: string }
  | { op: 'setPlacement'; itemId: string; placement: WorkPlacement; ifVersion: string | null }
  | { op: 'setParent'; itemId: string; spaceKey: string; parentId: string | null; ifVersion: string | null }
  | { op: 'reorder'; itemId: string; afterId: string | null }
  | { op: 'addRelation'; itemId: string; kind: WorkRelationKind; otherKey: string }
  | { op: 'removeRelation'; itemId: string; relationId: string }
  | { op: 'listComments'; itemId: string }
  | { op: 'addComment'; itemId: string; body: string }
  /**
   * 작업 링크 쓰기·지우기(LIFE-603 C14 · L1a 대비) — 능력 `workLinkStore`. main 만 보낸다(렌더러 요청 손검증은 받지 않는다).
   * corral 로컬 링크(`repos.json`)가 정본이고, 이 연산은 출처에도 같은 링크를 남기는 사본이다 — 실패해도 로컬 링크는 그대로다.
   */
  // LIFE-635: `machine` = 이 Mac 의 고정 이름(저장·지우기·재기동에 같은 값 — 다르면 지우기가 그 행을 못 찾는다) ·
  // `repo` = 레포 표시 이름 — 저장마다 함께 싣는다(LA 는 같은 링크를 다시 저장하면 repo 를 통째로 덮는다 — 생략 = null 로 덮음, LIFE-609 R2-F1).
  | { op: 'saveWorkLink'; itemId: string; link: WorkLink; machine: string; repo: string | null }
  | { op: 'removeWorkLink'; itemId: string; link: WorkLink; machine: string }

export type WorkOp = WorkCall['op']

export type WorkResult =
  | { op: 'listSpaces'; spaces: WorkSpace[]; capabilities: WorkCapabilities }
  | { op: 'listStatuses'; statuses: WorkStatus[]; kinds: WorkKind[] }
  | { op: 'listItems'; items: WorkItem[]; nextCursor: string | null; truncated: boolean }
  | { op: 'getItem'; item: WorkItem }
  /** 없으면 null — 「없음」 은 오류가 아니다(검색·작업 중이 「작업을 찾지 못함」 으로 그린다). */
  | { op: 'findByKey'; item: WorkItem | null }
  /** `blocked` = 갈 수 있는 전이가 있지만 corral 이 채울 수 없는 필수 필드를 묻는 상태(LIFE-605 C4) — `statusKeys` 에 없고 이유와 함께 흐린다. */
  | { op: 'listTransitions'; statusKeys: string[]; blocked: { statusKey: string; reason: string }[] }
  /**
   * 쓰기 결과는 **단건 모양**이다(LIFE-623) — `body`·`relations` 가 직후 `getItem` 과 같은 정본(본문 null = 빈 본문). 화면은 이 값을 그대로 기준으로 쓰고
   * 옛 값으로 보충하지 않는다. 출처는 쓰기 뒤 단건을 다시 읽어 싣는다(계약 묶음 「쓰기 결과는 단건 모양」 이 세 출처를 검사한다).
   */
  | { op: 'changeStatus' | 'setPlacement' | 'setParent' | 'reorder' | 'updateItem' | 'createItem'; item: WorkItem }
  | { op: 'listChildren'; items: WorkItem[] }
  | { op: 'getCreateMeta'; meta: WorkCreateMeta }
  | { op: 'listHistory'; entries: WorkHistoryEntry[] }
  /** `mode` = 실제로 찾은 방식 · `note` = 질의가 거부돼 텍스트로 찾았을 때의 사유(출처 글, 길이 상한·자격 지움) · `truncated` = 상한에서 끊음. */
  | { op: 'searchItems'; items: WorkItem[]; mode: 'query' | 'text'; note: string | null; truncated: boolean }
  | { op: 'addRelation'; relation: WorkRelation }
  | { op: 'removeRelation'; relationId: string }
  | { op: 'listComments'; comments: WorkComment[] }
  | { op: 'addComment'; comment: WorkComment }
  /** 그 작업의 출처 링크 목록 전체(LA 응답 그대로 — 다른 machine 의 행 포함). */
  | { op: 'saveWorkLink' | 'removeWorkLink'; workLinks: WorkLinkRecord[] }

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
  /** 저장 충돌(`conflict`)일 때 서버의 지금 값(E7). 출처가 모르면 없다. */
  conflict?: WorkConflict
  /**
   * 쓰기가 출처에 닿았을 수 있는데 결과를 모른다(LIFE-604 R1-A) — 시간 초과·응답 끊김·응답 모양 깨짐. 분류(`kind`)는 그대로 두고 덧붙인다(K2).
   * 화면은 실패로 읽지 않는다 — 목록을 다시 확인하기 전에는 같은 쓰기를 다시 보내게 하지 않는다. 보내기 전 실패(DNS·연결 거부)·출처의 거절에는 없다.
   */
  maybeApplied?: true
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

/**
 * 연결에 토큰 말고 더 필요한 칸 하나(LIFE-605 C1 — Jira 사이트·이메일). **비밀이 아니다** — 연결 파일에 그대로 두고 카드에 보인다.
 * 화면은 이 목록으로 폼 칸을 그린다(출처 이름으로 분기하지 않는다). 값 검증·정규화는 main(출처)이 네트워크 전에 한다.
 */
export type WorkAccountField = {
  key: string
  label: string
  placeholder: string
  /** 칸 아래 각주. 없으면 null. */
  hint: string | null
  input: 'url' | 'email' | 'text'
  /** 카드 어디에 보이나 — 제목 뒤(「Jira Cloud · acme.atlassian.net」) 또는 메타 줄 앞(「dev@acme.com · API 토큰 ••••7c2e」). */
  shownIn: 'title' | 'meta'
  /** 토큰을 바꿀 때 고칠 수 없다 — 다른 값이면 다른 연결이다. 화면은 읽기 전용으로 미리 채운다. */
  fixedOnReplace: boolean
}

/** 출처 하나의 표시 정보 — 화면은 이것만 그린다(출처 이름으로 분기하지 않는다). */
export type WorkSourceDescriptor = {
  id: string
  name: string
  /** 카드 아이콘 자리 글자(LA · J). */
  mono: string
  addLabel: string
  formTitle: string
  /** 토큰 앞에 받는 칸(LIFE-605). 비면 토큰 하나(LA). */
  accountFields: WorkAccountField[]
  tokenLabel: string
  /** 토큰 칸 각주(어디서 만드나). 없으면 null. */
  tokenHint: string | null
  /** 토큰이 이 접두사로 시작해야 한다 — 화면은 보내기 전에, main 은 네트워크 전에 다시 거절한다. 없으면 null. */
  tokenPrefix: string | null
  /**
   * 사람 키의 모양 (E3 · LIFE-601) — 정규식 소스, 앵커 없이(`LIFE-\d+`). 대소문자 무시로 쓴다. 화면은 이것으로만 검색어·브랜치 이름의
   * 키를 알아본다(출처 이름으로 분기하지 않는다 — K3). 없으면 null — 키 우선 검색·작업 중 감지를 하지 않는다.
   */
  keyPattern: string | null
  /**
   * 질의 모양 (LIFE-605 C5) — 정규식 소스, 대소문자 무시. 검색어가 이 모양이고 연결의 `querySearch` 가 켜져 있으면 화면이 `searchItems` 로 보낸다.
   * 없으면 null.
   */
  queryPattern: string | null
}

export type WorkSpaceToggle = { key: string; name: string; color: string | null; openCount: number | null; hidden: boolean; capabilities: WorkSpaceCapabilities }

export type WorkConnectionSummary = {
  id: string
  sourceId: string
  name: string
  mono: string
  tokenTail: string
  /** 비밀 아닌 연결 칸 값(LIFE-605 — Jira 사이트 호스트·이메일). 키는 descriptor `accountFields[].key`. LA 는 빈 객체. */
  account: Record<string, string>
  addedAt: number
  /** 자격 세대 — 토큰 교체·해제 때 오른다. 화면이 이전 자격의 로컬 결과(누른 테스트의 실패 줄)를 버리는 데 쓴다(R3-C). */
  generation: number
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
  /**
   * 이 Mac 의 이름(LIFE-635) — 출처 링크의 `machine` 과 견줘 로컬 worktree 와 같은 링크를 가른다. 아직 못 읽었으면 null · 칸 없음도 null 과 같다
   * (화면은 모를 때 원격 링크 목록을 그리지 않는다 — 내 링크를 남의 것으로 잘못 보이지 않게).
   */
  machine?: string | null
}

/** `account` = descriptor `accountFields` 의 값(키 → 글). 없는 출처는 생략하거나 빈 객체. */
export type WorkConnectionAddInput = { sourceId: string; token: string; account?: Record<string, string>; replaceId: string | null }
export type WorkConnectionAddResult = { ok: true; connection: WorkConnectionSummary } | { ok: false; error: WorkError }
export type WorkActionResult = { ok: true } | { ok: false; error: WorkError }

/** 오류 → 연결 상태. 연결 상태를 바꾸지 않는 오류는 null. */
export function connectionStatusOf(kind: WorkErrorKind): Exclude<WorkConnectionStatus, 'testing'> | null {
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
    case 'findByKey':
    case 'listTransitions':
    case 'listChildren':
    case 'createItem':
    case 'getCreateMeta':
      return null
    case 'listHistory':
      return 'history'
    case 'searchItems':
      return 'querySearch'
    case 'updateItem':
      return call.ifVersion === null ? null : 'conflictCheck'
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
    case 'saveWorkLink':
    case 'removeWorkLink':
      return 'workLinkStore'
  }
}

/** `setPlacement`·`setParent` 는 자기 능력 + (판이 있으면) 충돌 검사 둘을 본다. */
export function capabilitiesOf(call: WorkCall): WorkCapabilityName[] {
  const own = capabilityOf(call)
  const list: WorkCapabilityName[] = own === null ? [] : [own]
  if ((call.op === 'setPlacement' || call.op === 'setParent') && call.ifVersion !== null) list.push('conflictCheck')
  // 배치를 실은 만들기 — 배치 능력이 꺼진 출처에 「받는 척」 보내지 않는다(LIFE-604 E10).
  if (call.op === 'createItem' && call.placement !== undefined) list.push('placement')
  // 갈래를 실은 상태 변경 — 갈래 고르기 능력이 꺼진 출처에 보내지 않는다(LIFE-605 C4⑥).
  if (call.op === 'changeStatus' && call.resolution !== undefined && call.resolution !== null) list.push('resolution')
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

/** 질의 검색 상한(LIFE-605) — 검색어 길이 · 한 번에 묻는 스페이스 수. */
export const WORK_QUERY_MAX = 500
export const WORK_SEARCH_SPACES_MAX = 50

/** 본문 상한 — 렌더러가 보내는 본문(편집기·체크 칸 저장). 출처 상한은 출처가 따로 거절한다. */
export const WORK_BODY_MAX = 200_000
/** 제목 상한 — 수정(E4)·만들기(E10) 손검증과 만들기 화면이 같은 값을 쓴다(R4-E). */
export const WORK_TITLE_MAX = 500
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/

/** 필드 부분 수정 손검증 — 모르는 칸·빈 수정은 null. 제목은 비면 안 되고, 마감은 UTC ISO 또는 null. */
function readFieldPatch(value: unknown): WorkFieldPatch | null {
  if (!isRecord(value)) return null
  const patch: WorkFieldPatch = {}
  for (const key of Object.keys(value)) if (key !== 'title' && key !== 'body' && key !== 'priority' && key !== 'dueAt') return null
  if ('title' in value) {
    if (typeof value.title !== 'string' || value.title.trim().length === 0 || value.title.length > WORK_TITLE_MAX) return null
    patch.title = value.title
  }
  if ('body' in value) {
    if (typeof value.body !== 'string' || value.body.length > WORK_BODY_MAX) return null
    patch.body = value.body
  }
  if ('priority' in value) {
    const priority = value.priority === null ? null : readWorkPriority(value.priority)
    if (value.priority !== null && priority === null) return null
    patch.priority = priority
  }
  if ('dueAt' in value) {
    if (value.dueAt !== null && (typeof value.dueAt !== 'string' || !ISO_UTC.test(value.dueAt) || Number.isNaN(Date.parse(value.dueAt)))) return null
    patch.dueAt = value.dueAt
  }
  return Object.keys(patch).length === 0 ? null : patch
}

function readPlacement(value: unknown): WorkPlacement | null {
  return value === 'board' || value === 'backlog' ? value : null
}

const CREATE_KEYS = new Set(['op', 'spaceKey', 'parentId', 'kindKey', 'title', 'body', 'statusKey', 'priority', 'placement', 'fields'])

/**
 * 만들기 손검증(E10) — 모르는 칸이 하나라도 있으면 null(= `invalid_request`). 조용히 버리지 않는다(F1).
 * 값이 `undefined` 인 칸은 없는 칸으로 본다(IPC 구조 복제가 남기는 빈 자리).
 */
function readCreateCall(value: Record<string, unknown>): Extract<WorkCall, { op: 'createItem' }> | null {
  for (const key of Object.keys(value)) if (value[key] !== undefined && !CREATE_KEYS.has(key)) return null
  const parentId = value.parentId ?? null
  const title = value.title
  if (!isNonEmpty(value.spaceKey) || !(parentId === null || isNonEmpty(parentId)) || !isNonEmpty(value.kindKey)) return null
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > WORK_TITLE_MAX) return null
  const call: Extract<WorkCall, { op: 'createItem' }> = { op: 'createItem', spaceKey: value.spaceKey, parentId, kindKey: value.kindKey, title }
  if (value.body !== undefined) {
    if (typeof value.body !== 'string' || value.body.length > WORK_BODY_MAX) return null
    call.body = value.body
  }
  if (value.statusKey !== undefined) {
    if (!isNonEmpty(value.statusKey)) return null
    call.statusKey = value.statusKey
  }
  if (value.priority !== undefined) {
    const priority = value.priority === null ? null : readWorkPriority(value.priority)
    if (value.priority !== null && priority === null) return null
    call.priority = priority
  }
  if (value.placement !== undefined) {
    const placement = readPlacement(value.placement)
    if (placement === null) return null
    call.placement = placement
  }
  if (value.fields !== undefined) {
    const fields = readFieldValues(value.fields)
    if (fields === null) return null
    call.fields = fields
  }
  return call
}

function readFieldValues(value: unknown): WorkCreateFieldValue[] | null {
  if (!Array.isArray(value) || value.length > WORK_CREATE_FIELDS_MAX) return null
  const fields: WorkCreateFieldValue[] = []
  for (const entry of value) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => key !== 'key' && key !== 'value')) return null
    if (!isNonEmpty(entry.key) || typeof entry.value !== 'string' || entry.value.length > WORK_CREATE_FIELD_VALUE_MAX) return null
    if (fields.some((field) => field.key === entry.key)) return null
    fields.push({ key: entry.key, value: entry.value })
  }
  return fields
}

/**
 * 출처가 준 생성 메타 검증(E11) — main 이 출처 응답을 이것으로 본다. 어긋나면 null(= `invalid_response`).
 * 상태는 하나 이상·겹치지 않음·기본 상태가 그 안 · 필드 키 겹치지 않음 · 고르기 필드는 선택지 하나 이상(id 겹치지 않음) · `unavailable` 은 있으면 빈 글 아님.
 */
export function readCreateMeta(value: unknown): WorkCreateMeta | null {
  if (!isRecord(value) || !isNonEmpty(value.spaceKey) || !isNonEmpty(value.kindKey) || !isNonEmpty(value.defaultStatusKey)) return null
  const statusKeys = value.statusKeys
  if (!Array.isArray(statusKeys) || statusKeys.length === 0 || !statusKeys.every(isNonEmpty) || new Set(statusKeys).size !== statusKeys.length) return null
  if (!statusKeys.includes(value.defaultStatusKey)) return null
  if (value.placement !== 'applies' && value.placement !== 'ignored') return null
  const accepts = value.accepts
  if (!isRecord(accepts) || typeof accepts.body !== 'boolean' || typeof accepts.priority !== 'boolean') return null
  if (!Array.isArray(value.fields) || value.fields.length > WORK_CREATE_FIELDS_MAX) return null
  const fields: WorkCreateField[] = []
  for (const raw of value.fields) {
    const field = readCreateField(raw)
    if (field === null || fields.some((entry) => entry.key === field.key)) return null
    fields.push(field)
  }
  const meta: WorkCreateMeta = { spaceKey: value.spaceKey, kindKey: value.kindKey, statusKeys: [...statusKeys], defaultStatusKey: value.defaultStatusKey, placement: value.placement, accepts: { body: accepts.body, priority: accepts.priority }, fields }
  if (value.unavailable !== undefined) {
    if (!isNonEmpty(value.unavailable) || value.unavailable.length > 500) return null
    meta.unavailable = value.unavailable
  }
  return meta
}

function readCreateField(value: unknown): WorkCreateField | null {
  if (!isRecord(value) || !isNonEmpty(value.key) || !isNonEmpty(value.label)) return null
  switch (value.shape) {
    case 'text':
      return { key: value.key, label: value.label, shape: 'text' }
    case 'option': {
      if (!Array.isArray(value.options) || value.options.length === 0) return null
      const options: { id: string; label: string }[] = []
      for (const option of value.options) {
        if (!isRecord(option) || !isNonEmpty(option.id) || !isNonEmpty(option.label) || options.some((entry) => entry.id === option.id)) return null
        options.push({ id: option.id, label: option.label })
      }
      return { key: value.key, label: value.label, shape: 'option', options }
    }
    case 'unsupported':
      return isNonEmpty(value.sourceType) ? { key: value.key, label: value.label, shape: 'unsupported', sourceType: value.sourceType } : null
    default:
      return null
  }
}

/**
 * 만들기 칸이 메타에 맞는가(E10·E11) — 출처가 보내기 전에 쓴다(두 출처 같은 규칙). 맞으면 null, 아니면 거절 문구.
 * 상태는 메타 안 · 필드는 메타에 있는 키만 · 필수 필드는 전부 값(공백만 = 없음) · 고르기는 선택지 id · 채울 수 없는 모양이 있으면 거절.
 */
export function createFieldsProblem({ call, meta }: { call: Extract<WorkCall, { op: 'createItem' }>; meta: WorkCreateMeta }): string | null {
  if (meta.unavailable !== undefined) return meta.unavailable
  if (call.statusKey !== undefined && !meta.statusKeys.includes(call.statusKey)) return '이 상태로는 만들 수 없습니다 — 만들 수 있는 상태를 고르세요.'
  if (call.placement !== undefined && meta.placement === 'ignored') return '이 종류는 보드/백로그 배치를 받지 않습니다.'
  if (call.body !== undefined && call.body.length > 0 && !meta.accepts.body) return '이 종류는 만들 때 본문을 받지 않습니다 — 만든 뒤 본문을 쓰세요.'
  if (call.priority !== undefined && call.priority !== null && !meta.accepts.priority) return '이 종류는 만들 때 우선순위를 받지 않습니다.'
  const given = call.fields ?? []
  for (const value of given) if (!meta.fields.some((field) => field.key === value.key)) return `이 종류에 없는 필드입니다 (${value.key.slice(0, 64)}).`
  for (const field of meta.fields) {
    if (field.shape === 'unsupported') return `${field.label} 은(는) corral 에서 채울 수 없습니다 — 출처에서 만드세요.`
    const value = given.find((entry) => entry.key === field.key)?.value ?? ''
    if (value.trim().length === 0) return `필수 필드 ${field.label} 이(가) 비었습니다.`
    if (field.shape === 'option' && !field.options.some((option) => option.id === value)) return `${field.label} 에 없는 값입니다.`
  }
  return null
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
    case 'findByKey':
      return isNonEmpty(value.key) && value.key.length <= 64 ? { op, key: value.key } : null
    case 'changeStatus': {
      const raw = value.resolution ?? null
      const resolution = raw === null ? null : pick(WORK_RESOLUTIONS, raw)
      if (raw !== null && resolution === null) return null
      return isNonEmpty(itemId) && isNonEmpty(value.statusKey) && isNullableString(ifVersion) ? { op, itemId, statusKey: value.statusKey, ifVersion, resolution } : null
    }
    case 'updateItem': {
      const fields = readFieldPatch(value.fields)
      return isNonEmpty(itemId) && fields !== null && isNullableString(ifVersion) ? { op, itemId, fields, ifVersion } : null
    }
    case 'listChildren':
    case 'listHistory':
      return isNonEmpty(itemId) ? { op, itemId } : null
    case 'createItem':
      return readCreateCall(value)
    case 'getCreateMeta':
      return isNonEmpty(value.spaceKey) && isNonEmpty(value.kindKey) ? { op, spaceKey: value.spaceKey, kindKey: value.kindKey } : null
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
    case 'searchItems': {
      const keys = value.spaceKeys
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > WORK_SEARCH_SPACES_MAX || !keys.every(isNonEmpty) || new Set(keys).size !== keys.length) return null
      return isString(value.query) && value.query.trim().length > 0 && value.query.length <= WORK_QUERY_MAX ? { op, spaceKeys: [...keys], query: value.query } : null
    }
    default:
      return null
  }
}

export function readWorkActivityQuery(value: unknown): WorkActivityQuery | null {
  if (!isRecord(value) || !isNonEmpty(value.connectionId) || !isNonEmpty(value.itemId)) return null
  if (value.itemKey !== undefined && !(isNonEmpty(value.itemKey) && value.itemKey.length <= 64)) return null
  return value.itemKey === undefined ? { connectionId: value.connectionId, itemId: value.itemId } : { connectionId: value.connectionId, itemId: value.itemId, itemKey: value.itemKey }
}

export function readWorkRequest(value: unknown): WorkRequest | null {
  if (!isRecord(value) || !isNonEmpty(value.requestId) || !isNonEmpty(value.connectionId)) return null
  const call = readWorkCall(value.call)
  return call === null ? null : { requestId: value.requestId, connectionId: value.connectionId, call }
}
