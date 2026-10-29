// 작업 상세 상태·자료 (LIFE-602) — 화면(TaskDetail)은 그리기만, 여기서 읽기·쓰기·충돌·활동을 한다.
//
// 비동기 결과를 언제 적용하는지는 이 파일 한 곳에서 정한다(규칙 원문 `specs/LIFE-602-task-detail/raw/claude/detail-async-rules.md`, 수정 5 — 범위 축소).
// - **열기 회차(session)**: 작업(uid) 또는 연결 세대가 바뀔 때마다 하나씩 오른다. 비동기 체인은 출발점(origin = 회차 + 대상)을 끝까지 들고,
//   결과는 그 회차가 살아 있을 때만 적용한다. 떠났으면 읽기는 버리고 쓰기는 `left`(R1-A·R2-A·R3-C).
// - **직렬화**: 그 작업에 쓰기(보드와 같은 잠금)나 상세 단건 읽기(첫 읽기·재조회·새로 불러오기)가 진행 중이면 새 쓰기(상세·보드 둘 다)는 보내지 않는다 —
//   화면은 그 칸들을 막고(`blocked`), 그래도 온 쓰기는 `busy`. 기다렸다 보내는 길은 없다. 그래서 쓰기의 판은 언제나 「진행 중인 것이 없을 때의 base」 다.
// - **편집 기준(basis)**: 초안(본문 편집기·제목)은 편집을 시작한 때의 base 를 기준으로 그 판으로 저장한다 — 다른 곳의 변경이 보여도 조용히 오르지 않는다(R3-A, C8).
//   오르는 것은 셋뿐: 읽기 값과 칸이 하나도 다르지 않을 때(판만 오름) · 내 쓰기가 기준의 판을 실어 보내 성공했을 때(그 결과로) ·
//   덮기가 성공한 그 칸(과 결과가 덮은 칸만 다른 초안). 덮기는 판 없이 가므로 다른 초안의 기준을 판 비교로 올리지 않는다(R6-A).
// - **충돌**: 충돌 검사가 켜진 출처의 충돌 응답은 언제나 배너다(자동 재시도 없음). 자기 충돌은 막아서 피한다(LIFE-632 C5): 같은 카드에 답이 안 온 쓰기(보드·상세,
//   30초 늦음 포함)가 있으면 상세 쓰기는 「앞 변경을 출처가 확인하는 중」 으로 기다린다 — 그 답을 받아 base 가 새 판이 된 뒤 보낸다.
// - **미확인 경계(LIFE-632 R5-A)**: 「적용됐을 수 있음」 신호를 받은 시각이 경계다. 그 시각 이하에 시작한 근거(읽기 시작·쓰기 보냄)는 미확인을 풀지 못하고 base 가 되지 않는다.
// - **되돌리기 토스트**: 그 쓰기의 결과 판 = 지금 base 판일 때만 그 판으로 보낸다. 같은 작업에 다음 쓰기(상세·보드)가 시작되거나 base 판이 결과 판과 달라지면 곧바로 사라진다.
// - **판 최신성(stamp)**: 읽기는 시작 시각이 지금 base 의 시각보다 뒤일 때만 base 가 된다(R2-D) — 보드 끌기 확정이 낡은 재조회에 덮이지 않게.
// - **늦은 확정**: 30초 확인 지연 뒤 온 결과는 즉시 결과와 같은 `finish` 로 간다(R2-F·G). 목록 묶음은 마지막 요청만(R2-H).
// - 쓰기는 작업 페이지의 `writeItem` 하나로 — 보드 끌기와 같은 잠금·세대·확인 지연(D3). 판(`ifVersion`)은 충돌 검사가 켜진 출처에서만.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  WorkActivityRecord,
  WorkCall,
  WorkCapabilities,
  WorkCapability,
  WorkComment,
  WorkError,
  WorkHistoryEntry,
  WorkItem,
  WorkResolutionChoice,
  WorkResponse,
  WorkResult,
  WorkStatus,
} from '../../../shared/work.js'
import { conflictFields, type ConflictField } from '../task-detail-model.js'
import { nextWorkStamp } from '../work-clock.js'
import { LatestGate, itemUid, writeBlock } from '../tasks-model.js'
import { request, type MoveNotice, type TasksPageModel } from './useTasksPage.js'

export type DetailTarget = { connectionId: string; itemId: string }

/** 비동기 체인의 출발점 — 시작한 열기 회차와 대상. 체인 끝까지 이것으로 읽고, await 뒤마다 이것이 아직 살아 있는지 본다(R3-C). */
type Origin = { session: number; target: DetailTarget }

/** 초안이 기준을 잡는 칸 — 본문 편집기 · 제목 칸(R3-A). */
export type EditSlot = 'body' | 'title'

/** 능력에 기대는 묶음 — 받는 중 · 받음 · 실패 · 꺼짐(숨김이면 reason null, 흐림이면 이유). */
export type Loaded<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string } | { state: 'off'; reason: string | null }

export type DetailConflict = { call: WorkCall; current: WorkItem; by: string | null; fields: ConflictField[]; at: number }

export type ParentRef = { id: string; key: string; title: string }

/** 확정된 쓰기 결과 — 즉시든 늦게든 같은 모양. `left` = 요청을 시작한 열기 회차를 떠났다(부르는 쪽은 아무것도 하지 않는다). */
export type DetailFinal = { kind: 'ok'; result: WorkResult } | { kind: 'failed'; error: WorkError } | { kind: 'busy' } | { kind: 'stale' } | { kind: 'left' }
/** 쓰기 결과 — 확정이거나, 확인 지연(30초)이면 나중에 확정을 주는 약속. */
export type DetailOutcome = DetailFinal | { kind: 'late'; settled: Promise<DetailFinal> }

/** 쓰기 하나 — 낙관적 화면 값, 성공 토스트 문구, 되돌리기(누를 때의 base 로 만든 역연산 — 그 base 는 이 쓰기의 결과 판이다). */
export type DetailWrite = {
  call: WorkCall
  optimistic: ((item: WorkItem) => WorkItem) | null
  label: string | null
  undo: ((base: WorkItem) => DetailWrite) | null
  /** 되돌리기로 보낸 쓰기 — 성공하면 「되돌렸습니다」. */
  undoing?: boolean
  /** 실패를 토스트로 알리지 않는다 — 화면이 그 자리에 문구를 보인다(연결·자식·코멘트 입력). 충돌은 그래도 배너. */
  quiet?: boolean
  /** 판을 싣지 않는다 — 「내 값으로 덮기」. */
  force?: boolean
  /** 덮기를 고를 때 배너가 보인 서버 값(`DetailConflict.current`) — 덮은 칸의 기준은 이 값에서 결과까지가 덮기로 설명될 때만 오른다(LIFE-632 리뷰 r3 X3-1). */
  seen?: WorkItem
  /** 초안의 저장 — 그 칸의 편집 기준 판으로 보낸다(R3-A). 없으면 지금 base 의 판. */
  basis?: EditSlot
}

/** 되돌리기 토스트 하나 — 결과 판(응답에 작업이 없던 쓰기는 뒤 재조회가 정한다)과 토스트를 지우는 손잡이. */
type UndoEntry = { version: string | null; pending: boolean; live: boolean; dismiss: (() => void) | null }

const OFF_HIDDEN: Loaded<never> = { state: 'off', reason: null }

function gateOf(capability: WorkCapability | undefined): Loaded<never> | null {
  if (capability === undefined || capability.state === 'on') return null
  return capability.state === 'hidden' ? OFF_HIDDEN : { state: 'off', reason: capability.reason }
}

/** 판을 싣는 쓰기의 판을 정한다 — 그 쓰기의 기준 판 · 덮기는 판 없이. 판이 없는 연산은 그대로. */
function withVersion({ call, version }: { call: WorkCall; version: string | null }): WorkCall {
  switch (call.op) {
    case 'updateItem':
    case 'changeStatus':
    case 'setPlacement':
    case 'setParent':
      return { ...call, ifVersion: version }
    default:
      return call
  }
}

/** 쓰기가 초안 칸의 값을 보내는가 — 「내 값으로 덮기」 가 성공하면 그 칸의 기준을 덮은 결과로 옮긴다(덮은 충돌을 다시 내지 않는다). */
function slotsOf(call: WorkCall): EditSlot[] {
  if (call.op !== 'updateItem') return []
  const slots: EditSlot[] = []
  if (call.fields.body !== undefined) slots.push('body')
  if (call.fields.title !== undefined) slots.push('title')
  return slots
}

/** 쓰기가 보낸 판 — 서버가 「지금 판 = 이것」 을 확인하고 받았다는 증거. 판 없이 간 쓰기(덮기·충돌 검사 꺼짐·판 없는 연산)는 null. */
function sentVersion(call: WorkCall): string | null {
  switch (call.op) {
    case 'updateItem':
    case 'changeStatus':
    case 'setPlacement':
    case 'setParent':
      return call.ifVersion
    default:
      return null
  }
}

/** 쓰기가 바꾸는 칸 — 충돌 칸 이름으로. 덮기 뒤 다른 초안의 기준이 「이 쓰기가 바꾼 칸만」 다를 때를 가린다. */
function fieldsOf(call: WorkCall): ConflictField[] {
  switch (call.op) {
    case 'updateItem': {
      const fields: ConflictField[] = []
      if (call.fields.title !== undefined) fields.push('title')
      if (call.fields.body !== undefined) fields.push('body')
      if (call.fields.priority !== undefined) fields.push('priority')
      if (call.fields.dueAt !== undefined) fields.push('dueAt')
      return fields
    }
    case 'changeStatus':
      return ['status']
    case 'setPlacement':
      return ['placement']
    case 'setParent':
      return ['parent']
    default:
      return []
  }
}

/** 갈래를 보내지 않은 완료 이동의 갈래 — 계약 기본(`WorkCall.changeStatus` 「null 이면 출처 기본(완료함)」). */
const DEFAULT_RESOLUTION: WorkResolutionChoice = 'completed'

/** 기준 → 결과의 다른 칸이 **전부** 내 쓰기 `mine` 이 보낸 칸이고 결과 값 = 보낸 값인가(`proves`). 설명되지 않는 칸이 하나라도 있으면 false. */
function explainedBy({ basis, next, mine, statuses }: { basis: WorkItem; next: WorkItem; mine: WorkCall | null; statuses: WorkStatus[] | null }): boolean {
  if (basis.id !== next.id) return false
  return conflictFields({ base: basis, current: next }).every((field) => mine !== null && fieldsOf(mine).includes(field) && proves({ call: mine, field, current: next, statuses }))
}

/**
 * 내 쓰기가 그 칸을 지금 값으로 만들었다고 볼 수 있는가 — 그 칸을 보냈고 결과 값이 보낸 값과 같다(LIFE-632 C5 ① · 리뷰 r1 X1-2).
 * 상태는 완료 갈래(resolution)까지(X1-3). 갈래를 보내지 않았으면 계약(`WorkCall.changeStatus` — null 이면 출처 기본 완료함)대로 기대한다:
 * 완료 분류 상태면 완료함, 아니면 갈래 없음(LIFE-632 리뷰 r2 X2-1). 분류는 상세가 아는 상태 목록(`statuses`)에서 — 모르는 상태면 설명하지 않는다(배너, 보수적).
 * 부모는 보낸 값과 표시 부모가 달라 견주지 않는다(설명 안 됨). 값이 같은지만 본다 — 외부가 같은 값을 넣은 것과 구별하지 못한다(ABA 한계, design-notes §4).
 */
function proves({ call, field, current, statuses }: { call: WorkCall; field: ConflictField; current: WorkItem; statuses: WorkStatus[] | null }): boolean {
  switch (call.op) {
    case 'updateItem': {
      const fields = call.fields
      if (field === 'title') return fields.title !== undefined && fields.title === current.title
      if (field === 'body') return fields.body !== undefined && fields.body === (current.body ?? '')
      if (field === 'priority') return fields.priority !== undefined && fields.priority === current.priority
      if (field === 'dueAt') return fields.dueAt !== undefined && (fields.dueAt === null || current.dueAt === null ? fields.dueAt === current.dueAt : Date.parse(fields.dueAt) === Date.parse(current.dueAt))
      return false
    }
    case 'changeStatus': {
      if (field !== 'status' || call.statusKey !== current.statusKey) return false
      if (call.resolution !== undefined && call.resolution !== null) return current.resolution === call.resolution
      const category = statuses?.find((status) => status.key === call.statusKey)?.category
      if (category === undefined) return false
      return current.resolution === (category === 'done' ? DEFAULT_RESOLUTION : null)
    }
    case 'setPlacement':
      return field === 'placement' && call.placement === current.placement
    default:
      return false
  }
}

/** 응답에 이 작업의 새 값이 실려 오는가 — 아니면(연결·자식·코멘트) 단건을 다시 읽어야 판이 맞는다. */
function carriesItem({ result, itemId }: { result: WorkResult; itemId: string }): boolean {
  return 'item' in result && result.item !== null && result.item.id === itemId
}

type DetailPhase = { state: 'idle' | 'loading' | 'ready' | 'error'; message: string | null }
/** 정본을 받았다 — 지난 읽기 오류(「서버 값을 다시 받지 못했습니다」)를 걷는다(LIFE-623 R4-C). 불러오는 중·빈 상태는 그대로. */
function recovered(phase: DetailPhase): DetailPhase {
  return phase.state === 'error' ? { state: 'ready', message: null } : phase
}

type Settled = { kind: 'ok'; result: WorkResult } | { kind: 'failed'; error: WorkError } | { kind: 'busy' } | { kind: 'stale' }

export function useTaskDetail({ open, target, page, notify }: { open: boolean; target: DetailTarget | null; page: TasksPageModel; notify: (notice: MoveNotice) => void }) {
  const gate = useRef(new LatestGate()).current
  const uid = target === null ? null : itemUid(target)
  const connection = target === null ? null : page.settings?.connections.find((entry) => entry.id === target.connectionId) ?? null
  const generation = connection?.generation ?? 0

  // 열기 회차 — 작업 또는 세대가 바뀌면 하나 오른다. 렌더 중에 정해 같은 렌더의 모든 콜백이 같은 회차를 본다.
  const sessionKey = uid === null ? '' : `${uid}#${generation}`
  const sessionRef = useRef({ key: '', n: 0 })
  if (sessionRef.current.key !== sessionKey) sessionRef.current = { key: sessionKey, n: sessionRef.current.n + 1 }
  const session = sessionRef.current.n
  const alive = useCallback((started: number): boolean => sessionRef.current.n === started, [])
  /** 지금 렌더의 출발점 — 사용자 동작·이 렌더의 effect 가 시작하는 체인은 이것을 든다. */
  const here = useMemo<Origin | null>(() => (target === null ? null : { session, target }), [session, target])

  // 판 최신성 시계 — 읽기 시작·쓰기 시작·쓰기 확정마다 오른다. base 는 자기를 만든 사건의 시각을 갖는다.
  /** 읽기 무효화 시각 — 이보다 먼저 시작한 읽기는 base 가 되지 못한다. 쓰기 시작(성공 여부 무관)·확정·읽기 수용에서 오른다. */
  const baseStampRef = useRef(0)
  /**
   * 확인된 base 의 근거 시각(LIFE-623 R3-A) — 지금 base 를 만든 읽기의 시작 시각 또는 확정 쓰기를 **보낸** 시각. 성공해 받은 것만 올린다(실패한 쓰기는 올리지 않는다).
   * 늦게 온 확정 쓰기의 순서 가드는 이 시각과 비교한다 — 무효화 시각과 비교하면 실패한 후속 쓰기 때문에 유효한 늦은 결과를 버린다.
   */
  const confirmedRef = useRef(0)
  /**
   * 미확인 경계(LIFE-632 R5-A) — 「적용됐을 수 있음」 신호를 받은 시각(같은 시계). 이 시각 **이하**에 시작한 근거(읽기 시작 · 쓰기를 보낸 시각)는 미확인을 풀지 못하고
   * base 가 되지 않는다. `confirmedRef`(확인된 base 의 근거)와 다른 값이다 — 무엇이 확인됐느냐가 아니라 「여기부터 그 전 근거는 믿지 않는다」 는 선. 0 = 경계 없음.
   * 신호 도착 시각으로 둔다(실패한 쓰기를 보낸 시각이 아니라) — 그 쓰기가 아직 답이 없던 동안 시작한 읽기·쓰기도 그 쓰기가 적용되기 전 값을 봤을 수 있다.
   */
  const fenceRef = useRef(0)
  /** 첫 읽기 체인이 단건에서 실패한 출발점(LIFE-632 R5-C) — 그 뒤 다른 길(보드 확정·재조회)로 정본을 받으면 부가 읽기를 그 출발점으로 이어 시작한다. */
  const extrasDueRef = useRef<Origin | null>(null)
  /**
   * 미확인(R3-A) — 순서 가드가 늦은 결과를 버렸거나 쓰기가 「적용됐을 수 있음」 으로 실패했는데(R4-A) 정본을 아직 다시 받지 못함.
   * 그동안 상세 쓰기는 막힌다(옛 base 로 저장하지 않게). 정본을 받으면 풀린다 — 지난 읽기 오류 표시도 함께 걷는다(R4-C).
   */
  const [unconfirmed, setUnconfirmed] = useState(false)
  // 확정 시각은 작업 페이지의 쓰기 「보낸 시각」 과 같은 시계(LIFE-623 R2-A, `work-clock`) — 늦게 온 옛 쓰기 결과를 base 의 근거와 비교한다.
  const tick = useCallback((): number => nextWorkStamp(), [])

  const [base, setBase] = useState<WorkItem | null>(null)
  const [item, setItem] = useState<WorkItem | null>(null)
  const baseRef = useRef(base)
  baseRef.current = base
  const rowsRef = useRef(page.rows)
  rowsRef.current = page.rows
  const loadDataRef = useRef(page.load.data)
  loadDataRef.current = page.load.data
  /** 칸별 편집 기준 — 초안이 있는 동안만 있다(R3-A). */
  const basesRef = useRef(new Map<EditSlot, WorkItem>())
  /** 진행 중인 단건 읽기 수 — 회차별(떠난 회차의 늦은 읽기가 새 회차를 막지 않게). 직렬화의 「상세 재조회 중」. */
  const readsRef = useRef(new Map<number, number>())
  const [, setReadsSeen] = useState(0)
  /** 살아 있는 되돌리기 토스트 — 다음 쓰기·판 변화에 사라진다. */
  const undosRef = useRef<UndoEntry[]>([])
  const [phase, setPhase] = useState<DetailPhase>({ state: 'idle', message: null })
  const [statuses, setStatuses] = useState<WorkStatus[] | null>(null)
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses
  const [parents, setParents] = useState<ParentRef[]>([])
  const [children, setChildren] = useState<Loaded<WorkItem[]>>({ state: 'loading' })
  const [comments, setComments] = useState<Loaded<WorkComment[]>>({ state: 'loading' })
  const [history, setHistory] = useState<Loaded<WorkHistoryEntry[]>>({ state: 'loading' })
  const [records, setRecords] = useState<WorkActivityRecord[]>([])
  const [conflict, setConflict] = useState<DetailConflict | null>(null)
  const [transitions, setTransitions] = useState<Loaded<string[]> | null>(null)
  /** 출처가 이유를 준 막힌 전이(LIFE-605 — corral 이 채울 수 없는 필수 필드를 묻는 전이). 메뉴에 흐린 행 + 이유. */
  const [transitionBlocks, setTransitionBlocks] = useState<{ statusKey: string; reason: string }[]>([])
  const [readSeq, setReadSeq] = useState(0)
  const activitySeqRef = useRef(0)

  const caps: WorkCapabilities | null = connection?.capabilities ?? null
  const descriptor = connection === null ? null : page.settings?.sources.find((source) => source.id === connection.sourceId) ?? null
  const capsRef = useRef(caps)
  capsRef.current = caps
  const locked = uid !== null && page.busy.has(uid)
  /**
   * 같은 카드에 답이 안 온 쓰기(보드·상세, 늦음 포함)가 있다 — 상세 쓰기는 기다린다(LIFE-632 C5, 자기 충돌 배너 대신). 충돌 검사가 켜진 출처에서만 —
   * 꺼진 출처는 판을 싣지 않아 자기 충돌이 없고, 늦은 쓰기 뒤 순서는 확정 순서 가드·미확인이 맡는다(LIFE-623).
   */
  const waiting = uid !== null && page.unanswered.has(uid) && caps?.conflictCheck.state === 'on'
  const reading = (readsRef.current.get(session) ?? 0) > 0
  /** 확인하는 중 표시 — 잠금(앞 쓰기 확인 중) 또는 받은 뒤의 단건 재조회. */
  const busy = locked || waiting || (reading && base !== null)
  /**
   * 쓰기 막힘 이유 — 연결 상태(권한·끊김·인증) → 그 작업의 앞 쓰기 확인 중 → 상세를 아직 받지 않음(R3-E, 받기에 실패했으면 그 사실 — R6-E) → 상세를 다시 받는 중(직렬화).
   * 막혀 있으면 화면은 그 칸을 막고, 그래도 온 쓰기는 보내지 않는다(기다렸다 보내지 않는다).
   */
  const blocked = writeBlock(connection?.status ?? null)?.reason ?? (locked || waiting ? '앞 변경을 출처가 확인하는 중…' : null) ?? (base === null && target !== null ? (phase.state === 'error' ? '상세를 받지 못했습니다 — 다시 시도하세요.' : '상세를 불러오는 중…') : null) ?? (reading ? '상세를 다시 받는 중…' : null)
    ?? (unconfirmed ? (phase.state === 'error' ? '서버 값을 다시 받지 못했습니다 — 다시 시도해 받은 뒤 고치세요.' : '서버 값을 다시 맞추는 중…') : null)
  const blockedRef = useRef(blocked)
  blockedRef.current = blocked
  const versionOf = useCallback((current: WorkItem | null): string | null => (capsRef.current?.conflictCheck.state === 'on' ? current?.version ?? null : null), [])

  /** 칸 편집을 시작한다 — 지금 base 를 그 칸의 기준으로 잡는다. */
  const holdBasis = useCallback((slot: EditSlot): void => {
    const current = baseRef.current
    if (current !== null) basesRef.current.set(slot, current)
  }, [])
  const dropBasis = useCallback((slot: EditSlot): void => { basesRef.current.delete(slot) }, [])
  /**
   * 서버 값이 기준과 칸이 하나도 다르지 않으면(판만 오름 — 코멘트·연결·자식 뒤) 그 기준을 새 값으로. 다른 칸이 있으면 두어 저장이 배너가 되게.
   * `mine` = 이 값을 만든 내 쓰기(LIFE-632 C5 ①) — 다른 칸이 전부 그 쓰기가 보낸 칸이고 결과 값 = 보낸 값이면 그 차이는 내 쓰기다(`proves`). 설명되지 않는 칸이
   * 하나라도 있으면(다른 칸 · 같은 칸 다른 값 — 결과 읽기 앞 외부 변경, 리뷰 r1 X1-2) 두어 저장이 배너가 되게.
   */
  const slideBases = useCallback(({ next, mine }: { next: WorkItem; mine: WorkCall | null }): void => {
    for (const [slot, basis] of basesRef.current) if (explainedBy({ basis, next, mine, statuses: statusesRef.current })) basesRef.current.set(slot, next)
  }, [])

  /** 되돌리기 토스트 하나를 끝낸다 — 토스트도 지운다. */
  const expire = useCallback((entry: UndoEntry): void => {
    if (!entry.live) return
    entry.live = false
    entry.dismiss?.()
    undosRef.current = undosRef.current.filter((other) => other !== entry)
  }, [])
  const expireAll = useCallback((): void => { for (const entry of [...undosRef.current]) expire(entry) }, [expire])

  /** base 를 바꾼다 — ref 와 상태를 같이. 판이 결과 판과 다른 되돌리기는 여기서 사라진다. */
  const putBase = useCallback((value: WorkItem): void => {
    baseRef.current = value
    setBase(value)
    for (const entry of [...undosRef.current]) if (!entry.pending && entry.version !== value.version) expire(entry)
  }, [expire])

  /** 단건 읽기 하나를 진행 중으로 센다 — 끝나면(버려져도) 뺀다. 작업 페이지에도 알려 그 카드의 보드 쓰기를 막는다(R6-D). */
  const holdRead = page.holdRead
  const tracked = useCallback(<T,>({ origin, run }: { origin: Origin; run: () => Promise<T> }): Promise<T> => {
    const count = (delta: number): void => {
      const next = (readsRef.current.get(origin.session) ?? 0) + delta
      if (next <= 0) readsRef.current.delete(origin.session)
      else readsRef.current.set(origin.session, next)
      setReadsSeen((value) => value + 1)
    }
    count(1)
    const release = holdRead(itemUid(origin.target))
    return run().finally(() => { count(-1); release() })
  }, [holdRead])

  /** 첫 읽기가 실패한 회차의 부가 읽기를 이어 시작한다(R5-C) — 아래 `resumeExtras`(부가 읽기 함수들 뒤에 정의)를 가리킨다. */
  const resumeRef = useRef<(value: WorkItem) => boolean>(() => false)

  /**
   * 단건 값을 base 로 받는다 — 시작 시각이 지금 base 보다 뒤이고 미확인 경계보다 뒤일 때만(R2-D · LIFE-632 R5-A). 받았으면 그 값을 돌려준다.
   * 경계 이하에 시작한 읽기는 미확인 전 값을 봤을 수 있다 — 막힘·오류를 풀지 않고 base 로 올리지 않는다(경계 뒤 재조회가 정한다).
   */
  const acceptItem = useCallback(({ value, stamp }: { value: WorkItem; stamp: number }): WorkItem | null => {
    if (stamp <= baseStampRef.current || stamp <= fenceRef.current) return null
    baseStampRef.current = stamp
    confirmedRef.current = stamp
    setUnconfirmed(false)
    setPhase(recovered)
    putBase(value)
    setItem(value)
    slideBases({ next: value, mine: null })
    resumeRef.current(value)
    return value
  }, [putBase, slideBases])

  /** 읽기 하나 — 같은 열쇠의 마지막 요청이고 출발 회차가 아직 살아 있을 때만 받는다. 떠난 체인은 요청도 내지 않는다(R3-C). */
  const read = useCallback(async ({ key, call, origin }: { key: string; call: WorkCall; origin: Origin }): Promise<WorkResponse | null> => {
    if (!alive(origin.session)) return null
    const requestId = gate.issue(key)
    const response = await request({ requestId, connectionId: origin.target.connectionId, call })
    return gate.accepts({ key, requestId }) && alive(origin.session) ? response : null
  }, [gate, alive])

  /** 단건 다시 읽기 — 진행 중으로 센다(직렬화). 받은 값(버려졌으면 null)을 돌려준다. */
  const refreshItem = useCallback((origin: Origin): Promise<WorkItem | null> => tracked({
    origin,
    run: async () => {
      const stamp = tick()
      const response = await read({ key: 'refresh', call: { op: 'getItem', itemId: origin.target.itemId }, origin })
      if (response === null || !response.ok || response.result.op !== 'getItem') return null
      return acceptItem({ value: response.result.item, stamp })
    },
  }), [read, acceptItem, tick, tracked])

  /** 순서 가드 뒤 정본 다시 받기(R3-A) — `refreshItem` 과 같되 실패를 상세 오류로 남긴다(「다시 시도」). 받으면 `acceptItem` 이 미확인을 푼다. */
  const reconcile = useCallback((origin: Origin): Promise<void> => tracked({
    origin,
    run: async () => {
      const stamp = tick()
      const response = await read({ key: 'refresh', call: { op: 'getItem', itemId: origin.target.itemId }, origin })
      if (response === null) return
      if (!response.ok || response.result.op !== 'getItem') {
        setPhase({ state: 'error', message: response.ok ? '출처 응답 모양이 다릅니다.' : response.error.message })
        return
      }
      acceptItem({ value: response.result.item, stamp })
    },
  }), [read, acceptItem, tick, tracked])

  /** 활동 묶음(corral 기록 + 출처 이력) — 묶음의 마지막 요청·같은 회차만 적용한다(R2-H). */
  const refreshActivity = useCallback(async (origin: Origin): Promise<void> => {
    if (!alive(origin.session)) return
    const { target } = origin
    const started = origin.session
    activitySeqRef.current += 1
    const mine = activitySeqRef.current
    const historyGate = gateOf(capsRef.current?.history)
    const [activity, listed] = await Promise.all([
      // 활동 조회 실패는 활동만 비운다 — 상세는 그대로(preload 가 없거나 거절해도 던지지 않는다).
      // LIFE-603 — 자동 연결된 worktree 의 사건은 작업 id 를 모르고 키로 남는다. 키를 같이 묻는다(목록 행 · 받은 단건).
      Promise.resolve().then(() => {
        const itemKey = baseRef.current?.key ?? rowsRef.current.find((row) => row.space.connectionId === target.connectionId && row.item.id === target.itemId)?.item.key
        return window.corral.workActivity({ connectionId: target.connectionId, itemId: target.itemId, ...(itemKey === undefined ? {} : { itemKey }) })
      }).catch(() => null),
      historyGate === null ? request({ requestId: `history-${started}-${mine}`, connectionId: target.connectionId, call: { op: 'listHistory', itemId: target.itemId } }) : Promise.resolve(null),
    ])
    if (!alive(started) || activitySeqRef.current !== mine) return
    if (activity !== null && activity.ok) setRecords(activity.records)
    if (historyGate !== null) setHistory(historyGate)
    else if (listed !== null) setHistory(listed.ok && listed.result.op === 'listHistory' ? { state: 'ready', value: listed.result.entries } : { state: 'error', message: listed.ok ? '출처 응답 모양이 다릅니다.' : listed.error.message })
  }, [alive])

  const refreshChildren = useCallback(async (origin: Origin): Promise<void> => {
    const response = await read({ key: 'children', call: { op: 'listChildren', itemId: origin.target.itemId }, origin })
    if (response === null) return
    setChildren(response.ok && response.result.op === 'listChildren' ? { state: 'ready', value: response.result.items } : { state: 'error', message: response.ok ? '출처 응답 모양이 다릅니다.' : response.error.message })
  }, [read])

  const refreshComments = useCallback(async (origin: Origin): Promise<void> => {
    if (!alive(origin.session)) return
    const off = gateOf(capsRef.current?.comments)
    if (off !== null) { setComments(off); return }
    const response = await read({ key: 'comments', call: { op: 'listComments', itemId: origin.target.itemId }, origin })
    if (response === null) return
    setComments(response.ok && response.result.op === 'listComments' ? { state: 'ready', value: response.result.comments } : { state: 'error', message: response.ok ? '출처 응답 모양이 다릅니다.' : response.error.message })
  }, [read, alive])

  /** 부모 경로 — 가장 가까운 조상부터. 보드 자료에 있으면 그것, 없으면 단건으로(최대 5). 단계마다 출발 회차를 다시 본다. */
  const loadParents = useCallback(async ({ start, origin }: { start: WorkItem; origin: Origin }): Promise<void> => {
    const chain: ParentRef[] = []
    let parentId = start.parentId
    for (let depth = 0; depth < 5 && parentId !== null; depth += 1) {
      if (!alive(origin.session)) return
      const known = page.rows.find((row) => row.space.connectionId === origin.target.connectionId && row.item.id === parentId)?.item ?? null
      let parent = known
      if (parent === null) {
        const response = await read({ key: `parent${depth}`, call: { op: 'getItem', itemId: parentId }, origin })
        parent = response !== null && response.ok && response.result.op === 'getItem' ? response.result.item : null
      }
      if (parent === null) break
      chain.push({ id: parent.id, key: parent.key, title: parent.title })
      parentId = parent.parentId
    }
    if (alive(origin.session)) setParents(chain)
  }, [page.rows, read, alive])

  // 작업이 바뀌면 다시 짓는다 — 보드 자료에 있는 행으로 먼저 그리고(본문·연결은 단건이 채운다).
  const targetKey = uid ?? ''
  useEffect(() => {
    setConflict(null)
    setTransitions(null)
    setParents([])
    setRecords([])
    baseStampRef.current = 0
    confirmedRef.current = 0
    fenceRef.current = 0
    setUnconfirmed(false)
    basesRef.current.clear()
    baseRef.current = null
    if (target === null) { setBase(null); setItem(null); setPhase({ state: 'idle', message: null }); return }
    const listed = page.rows.find((row) => row.space.connectionId === target.connectionId && row.item.id === target.itemId)?.item ?? null
    setBase(null)
    setItem(listed)
    setStatuses(null)
    setChildren({ state: 'loading' })
    setComments({ state: 'loading' })
    setHistory({ state: 'loading' })
    setPhase({ state: 'loading', message: null })
  }, [targetKey])

  // 회차가 바뀌면(작업·세대) 되돌리기 토스트는 모두 사라진다 — 아래 읽기 effect 가 단건부터 다시 읽는다. 세대만 바뀌었으면 화면 값·초안은 둔다(R2-C·I).
  useEffect(() => { expireAll() }, [session])

  /** 단건 뒤의 부가 읽기 — 상태 목록 · 부모 경로 · 자식 · 코멘트 · 활동. 출발점(origin)을 끝까지 든다. */
  const loadExtras = useCallback(async ({ loaded, origin }: { loaded: WorkItem; origin: Origin }): Promise<void> => {
    const known = loadDataRef.current.find((entry) => entry.connectionId === origin.target.connectionId && entry.spaceKey === loaded.spaceKey)?.statuses ?? null
    if (known !== null) setStatuses(known)
    else {
      const listed = await read({ key: 'statuses', call: { op: 'listStatuses', spaceKey: loaded.spaceKey }, origin })
      if (!alive(origin.session)) return
      if (listed !== null && listed.ok && listed.result.op === 'listStatuses') setStatuses(listed.result.statuses)
    }
    void loadParents({ start: loaded, origin })
    void refreshChildren(origin)
    void refreshComments(origin)
    void refreshActivity(origin)
  }, [read, alive, loadParents, refreshChildren, refreshComments, refreshActivity])

  /**
   * 첫 읽기가 단건에서 실패한 회차에 다른 길(보드 확정·재조회)로 정본이 오면 부가 읽기를 이어 시작한다(LIFE-632 R5-C) — 오류는 정본을 받으면 걷히므로(R4-C)
   * 「다시 시도」 없이 상태 메뉴·자식이 빈 채로 남지 않게. 한 번만. 떠난 회차·다른 작업이면 하지 않는다. 시작했으면 true.
   */
  const resumeExtras = useCallback((value: WorkItem): boolean => {
    const due = extrasDueRef.current
    if (due === null || !alive(due.session) || due.target.itemId !== value.id) return false
    extrasDueRef.current = null
    void loadExtras({ loaded: value, origin: due })
    return true
  }, [alive, loadExtras])
  resumeRef.current = resumeExtras

  // 첫 읽기 체인 — 출발점(origin)을 끝까지 든다. 단건 읽기는 진행 중으로 센다(직렬화). await 뒤마다 살아 있는지 보고, 아니면 후속을 시작하지 않는다(R3-C).
  useEffect(() => {
    if (!open || here === null) return
    const origin = here
    extrasDueRef.current = null
    void (async () => {
      const stamp = tick()
      const response = await tracked({ origin, run: () => read({ key: 'item', call: { op: 'getItem', itemId: origin.target.itemId }, origin }) })
      if (!alive(origin.session) || response === null) return
      if (!response.ok || response.result.op !== 'getItem') {
        setPhase({ state: 'error', message: response.ok ? '출처 응답 모양이 다릅니다.' : response.error.message })
        extrasDueRef.current = origin
        return
      }
      const loaded = response.result.item
      const accepted = acceptItem({ value: loaded, stamp })
      // 미확인 경계 이전에 시작한 읽기(R5-A)는 오류·막힘을 그대로 둔다 — 경계 뒤 재조회가 정한다. 더 새 base 에 밀린 것뿐이면 받은 것과 같다.
      if (accepted !== null || stamp > fenceRef.current) setPhase({ state: 'ready', message: null })
      await loadExtras({ loaded, origin })
    })()
  }, [open, session, readSeq])

  // 같은 작업에 보드 쓰기(끌기·보드 되돌리기)가 시작되면 상세의 되돌리기 토스트는 곧바로 사라진다(R6-B) — 상세 쓰기의 시작은 `write` 가 지운다.
  useEffect(() => {
    if (page.startedWrite !== null && page.startedWrite.uid === uid) expireAll()
  }, [page.startedWrite])

  // 확정된 쓰기(상세·보드 끌기, 즉시·늦게) — 서버 값을 받는다. 확정 시각을 올려 그 전에 시작한 읽기를 낡은 것으로 만든다.
  // 편집 기준은 읽기와 같은 규칙(칸이 하나도 다르지 않을 때만)으로 — 상세 쓰기의 기준은 `finish` 가 이미 옮겼다.
  // 쓰기 결과는 단건 모양이다(계약 `WorkResult` · LIFE-623) — 본문·연결의 null 은 정본의 빈 값이지 「안 실음」 이 아니다. 옛 값으로 보충하지 않는다:
  // 보충하면 옛 본문 + 새 판이 한 snapshot 이 되고 `slideBases` 가 그것을 열린 초안의 기준으로 올려 외부 비우기를 배너 없이 덮는다(R7-A).
  // 그 쓰기를 **보낸 시각**이 지금 base 의 근거(읽기 시작·상세 쓰기 시작·앞 확정 — 같은 시계) 이하면 이 결과는 base 보다 옛 근거다(먼저 보내 늦게 온 성공 —
  // 그 사이 더 새 확정·읽기가 base 가 됐다). 올리지 않고 단건을 다시 읽는다 — 정본은 읽기가 정한다(LIFE-623 R2-A). 보드 목록 정합화는 작업 페이지 몫이라 그대로다.
  useEffect(() => {
    const settled = page.settledWrite
    if (settled === null || settled.uid !== uid || here === null) return
    // 미확인 경계 이하에 보낸 쓰기(LIFE-632 R5-A)도 옛 근거다 — 실패한 B 는 `confirmedRef` 를 올리지 않으므로 경계와 따로 본다.
    if (settled.sent <= confirmedRef.current || settled.sent <= fenceRef.current) {
      // 미확인으로 두고 정본을 다시 받는다 — 실패하면 오류 + 「다시 시도」, 받기 전에는 쓰기 막힘(R3-A).
      setUnconfirmed(true)
      void reconcile(here)
      void refreshActivity(here)
      return
    }
    baseStampRef.current = tick()
    confirmedRef.current = settled.sent
    setUnconfirmed(false)
    setPhase(recovered)
    const next = settled.item
    putBase(next)
    setItem(next)
    // 이 값은 내 쓰기의 결과다 — 기준과 다른 칸이 그 쓰기가 바꾼 칸뿐이면 열린 초안의 기준을 옮긴다(LIFE-632 C5 ① — 본문 편집 중 보드 끌기가 자기 충돌 배너가 되지 않게).
    slideBases({ next, mine: settled.call })
    if (!resumeExtras(next)) void refreshActivity(here)
  }, [page.settledWrite])

  // 「적용됐을 수 있음」 으로 끝난 쓰기(상세·보드, 즉시·늦게 — LIFE-623 R4-A) — 서버 값이 지금 base 와 다를 수 있다(외부 비우기·교체 뒤 우리 쓰기가 적용됐는데 결과를 못 받음).
  // 옛 base 를 편집 기준으로 두지 않는다 — 미확인으로 두고 정본을 다시 받는다(순서 가드와 같은 막힘·「다시 시도」). 적용되지 않은 확정 실패는 base 그대로.
  useEffect(() => {
    const unsure = page.unsureWrite
    if (unsure === null || unsure.uid !== uid || here === null) return
    // 경계(LIFE-632 R5-A) — 이 시각 이하에 시작한 근거는 이제 미확인을 풀지 못한다. 아래 재조회는 경계 뒤에 시작한다.
    fenceRef.current = tick()
    setUnconfirmed(true)
    void reconcile(here)
  }, [page.unsureWrite])

  /** 응답에 이 작업이 없는 쓰기 뒤 — 단건(판)을 다시 읽고(진행 중 = 다음 쓰기 막힘), 연산에 따라 목록을 다시 읽는다(R1-D·E · R2-E·F). 쓰기의 출발점으로. */
  const afterForeign = useCallback(({ op, origin }: { op: WorkCall['op']; origin: Origin }): Promise<WorkItem | null> => {
    const done = refreshItem(origin)
    void refreshActivity(origin)
    if (op === 'createItem') void refreshChildren(origin)
    if (op === 'addComment') void refreshComments(origin)
    return done
  }, [refreshItem, refreshActivity, refreshChildren, refreshComments])

  /** 확정 처리 — 즉시 결과와 늦은 결과가 같은 길로 온다(R2-F·G). `late` 면 실패 토스트는 작업 페이지가 이미 냈다. */
  const finish = useCallback(({ spec, call, current, basis, origin, outcome, late }: { spec: DetailWrite; call: WorkCall; current: WorkItem; basis: WorkItem; origin: Origin; outcome: Settled; late: boolean }): DetailFinal => {
    const started = origin.session
    switch (outcome.kind) {
      case 'ok': {
        setConflict(null)
        const carried = carriesItem({ result: outcome.result, itemId: current.id }) && 'item' in outcome.result ? outcome.result.item : null
        if (carried !== null) {
          // 기준이 결과로 오르는 길(R6-A): 서버가 그 기준의 판을 확인하고 받은 쓰기(판을 실어 보냈고 그 판 = 기준 판 — **쓰기 직전까지** 다른 쓰기가 없었다).
          // 그것만으로는 결과까지 아무도 안 썼다는 증거가 아니다 — 결과는 쓰기 뒤 따로 읽은 단건일 수 있고(LA), 그 사이 외부 쓰기가 실린다(LIFE-632 리뷰 r2 X2-2).
          // 그래서 결과와 그 기준의 칸 차이가 **전부 이 쓰기로 설명될 때만**(칸·값, `explainedBy` — 확정 effect 의 기준 이동과 같은 대조) 오른다. 설명 안 되는 차이가 있으면 두어 다음 저장이 배너.
          // 덮기는 판 없이 가서 그 증거가 없다 — 같은 값 대조로 가른다(리뷰 r3 X3-1, 덮기 쓰기 뒤·결과 읽기 앞 외부 변경이 결과에 실려도 기준으로 올리지 않게):
          // 덮은 칸은 사용자가 배너에서 본 서버 값(`seen`)을 확인했으니 그 값 → 결과가 덮기로 설명되면(`forced`), 다른 칸의 초안은 자기 기준 → 결과가 덮기로 설명되면(`onlyMine`).
          const sent = sentVersion(call)
          const statuses = statusesRef.current
          for (const [slot, held] of basesRef.current) {
            const proven = sent !== null && held.version === sent && explainedBy({ basis: held, next: carried, mine: call, statuses })
            const forced = spec.force === true && spec.seen !== undefined && slotsOf(call).includes(slot) && explainedBy({ basis: spec.seen, next: carried, mine: call, statuses })
            const onlyMine = spec.force === true && explainedBy({ basis: held, next: carried, mine: call, statuses })
            if (proven || forced || onlyMine) basesRef.current.set(slot, carried)
          }
        }
        const fresh = carried === null ? afterForeign({ op: call.op, origin }) : null
        if (spec.undoing === true) notify({ kind: 'undone', label: `${current.key} 를 되돌렸습니다` })
        else if (spec.label !== null && spec.undo === null) notify({ kind: 'final', label: spec.label })
        else if (spec.label !== null && spec.undo !== null) {
          const undo = spec.undo
          // 결과 판 — 응답에 작업이 실려 왔으면 그 판, 아니면 뒤 재조회가 정한다(그동안은 쓰기도 막혀 있다).
          const entry: UndoEntry = { version: carried?.version ?? null, pending: carried === null, live: true, dismiss: null }
          undosRef.current = [...undosRef.current, entry]
          if (fresh !== null) {
            void fresh.then((value) => {
              if (value === null) { expire(entry); return }
              entry.version = value.version
              entry.pending = false
              if (baseRef.current?.version !== value.version) expire(entry)
            })
          }
          notify({
            kind: 'moved',
            label: spec.label,
            bind: (dismiss) => { if (entry.live) entry.dismiss = dismiss; else dismiss() },
            undo: () => {
              const now = baseRef.current
              // 결과 판 = 지금 판일 때만 — 그 사이 다음 쓰기·판 변화가 있었으면 이미 사라졌어야 한다(여기서도 다시 본다).
              if (!entry.live || entry.pending || !alive(started) || now === null || now.version !== entry.version) { expire(entry); return false }
              if (blockedRef.current !== null) {
                notify({ kind: 'failed', message: `${current.key} — ${blockedRef.current}` })
                return false
              }
              void writeRef.current({ ...undo(now), label: null, undo: null, undoing: true })
              return true
            },
          })
        }
        return outcome
      }
      case 'busy':
        setItem(baseRef.current)
        notify({ kind: 'failed', message: `${current.key} — 앞 변경을 출처가 확인하는 중입니다. 확인된 뒤 다시 하세요.` })
        return outcome
      case 'stale':
        setItem(baseRef.current)
        return outcome
      case 'failed': {
        setItem(baseRef.current)
        const conflictInfo = outcome.error.kind === 'conflict' ? outcome.error.conflict : undefined
        if (conflictInfo !== undefined) {
          // 충돌은 언제나 배너 — 자동으로 다시 보내지 않는다. 바뀐 칸 = 이 쓰기의 기준 값 vs 서버 지금 값(R3-A).
          setConflict({ call, current: conflictInfo.current, by: conflictInfo.by, fields: conflictFields({ base: basis, current: conflictInfo.current }), at: Date.parse(conflictInfo.current.updatedAt) || Date.now() })
        } else {
          if (spec.quiet !== true && !late) notify({ kind: 'failed', message: `${current.key} — ${outcome.error.message}` })
          // 늦은 실패는 그 사이 화면이 움직였을 수 있다 — 서버 정본을 다시 읽는다(R1-C). 적용됐을 수 있는 실패는 작업 페이지 신호로 미확인 재조회가 맡는다(R4-A).
          if (late && outcome.error.maybeApplied !== true) void refreshItem(origin)
        }
        return outcome
      }
    }
  }, [afterForeign, notify, alive, refreshItem, expire])

  /**
   * 쓰기 하나 — 이 렌더의 회차에서만, 막혀 있지 않을 때만(직렬화) 보낸다. 판은 초안 칸이면 그 칸의 편집 기준, 아니면 지금 base.
   * 시작하면 이 작업의 되돌리기 토스트는 모두 사라진다. 결과는 시작한 회차에서만 `finish` 로.
   */
  const write = useCallback(async (spec: DetailWrite): Promise<DetailOutcome> => {
    if (here === null || !alive(here.session)) return { kind: 'left' }
    const origin = here
    const started = origin.session
    const current = baseRef.current
    if (current === null) return { kind: 'stale' }
    if (blockedRef.current !== null) {
      notify({ kind: 'failed', message: `${current.key} — ${blockedRef.current}` })
      return { kind: 'busy' }
    }
    expireAll()
    const basis = (spec.basis === undefined ? undefined : basesRef.current.get(spec.basis)) ?? current
    const call = withVersion({ call: spec.call, version: spec.force === true ? null : versionOf(basis) })
    if (spec.optimistic !== null) {
      const apply = spec.optimistic
      setItem((value) => (value === null ? value : apply(value)))
    }
    // 쓰기 시작 — 그 전에 시작한 읽기는 이제 낡았다(R2-D).
    baseStampRef.current = tick()
    const outcome = await page.writeItem({ connectionId: origin.target.connectionId, spaceKey: current.spaceKey, itemId: current.id, call, optimistic: spec.optimistic })
    if (!alive(started)) return { kind: 'left' }
    if (outcome.kind === 'late') {
      const settled = outcome.settled.then((late): DetailFinal => {
        if (!alive(started) || late.kind === 'stale') return { kind: 'left' }
        return finish({ spec, call, current, basis, origin, outcome: late, late: true })
      })
      return { kind: 'late', settled }
    }
    return finish({ spec, call, current, basis, origin, outcome, late: false })
  }, [here, notify, page, alive, versionOf, finish, tick, expireAll])
  const writeRef = useRef(write)
  writeRef.current = write

  /** 확정까지 기다린다 — 늦은 쓰기는 그 약속을, 아니면 그대로. 입력 정리는 이 결과로만 한다. */
  const finalOf = useCallback((outcome: DetailOutcome): Promise<DetailFinal> => (outcome.kind === 'late' ? outcome.settled : Promise.resolve(outcome)), [])

  /** 키로 그 작업이 있는지 읽어 본다 — 연결 추가 전에(R1-H, 없는 키에 쓰기를 보내지 않는다). 떠났으면 null. */
  const lookupKey = useCallback(async (key: string): Promise<{ found: true; item: WorkItem } | { found: false; message: string } | null> => {
    if (here === null) return null
    const response = await read({ key: 'lookup', call: { op: 'findByKey', key }, origin: here })
    if (response === null) return null
    if (!response.ok) return { found: false, message: response.error.message }
    if (response.result.op !== 'findByKey') return { found: false, message: '출처 응답 모양이 다릅니다.' }
    return response.result.item === null ? { found: false, message: `${key} — 없는 작업입니다.` } : { found: true, item: response.result.item }
  }, [read, here])

  /** 「새로 불러오기」·「다시 시도」 — 서버 값으로 다시 그린다(미저장 편집은 화면이 버린다). 읽기가 실패하면 첫 읽기 체인이 오류를 남긴다(R6-E). */
  const reloadFromServer = useCallback(() => {
    // 진행 중인 쓰기·읽기가 있으면 하지 않는다(직렬화 — 버튼도 막혀 있다).
    if (locked || reading) return
    setConflict(null)
    setPhase({ state: 'loading', message: null })
    setReadSeq((value) => value + 1)
  }, [locked, reading])
  /**
   * 이 작업의 로컬 링크가 바뀌었다(사이드바 떼기·다른 곳의 시작 — LIFE-635 X5-1) — 단건을 다시 읽어 출처 링크(`workLinks`)를 새로 받는다.
   * 「다른 곳의 링크」 는 단건과 지금 트리를 견주므로, 단건이 낡으면 방금 뗀 worktree 가 원격 행으로 남는다. 쓰기 중이면 그 쓰기 뒤 재조회가 맡는다.
   */
  const refreshLinks = useCallback(() => {
    // 상세가 보일 때만(LIFE-682 r2-1 — 숨긴 채 마운트된 상세는 읽지 않는다). 다시 보이면 첫 읽기 체인이 단건·링크를 새로 받는다.
    if (open && here !== null && !locked) void refreshItem(here)
  }, [open, here, locked, refreshItem])
  /** 다시 읽을 수 있는가 — 진행 중인 쓰기·읽기가 없을 때(「다시 시도」 버튼). */
  const canReload = !locked && !reading

  /** 「내 값으로 덮기」 — 같은 쓰기를 판 없이 다시. */
  const overrideConflict = useCallback(async (): Promise<DetailFinal | null> => {
    if (conflict === null) return null
    const final = await finalOf(await write({ call: conflict.call, optimistic: null, label: null, undo: null, force: true, seen: conflict.current }))
    if (final.kind === 'ok') setReadSeq((value) => value + 1)
    return final
  }, [conflict, write, finalOf])

  const loadTransitions = useCallback(async (): Promise<void> => {
    if (here === null || caps?.transition.mode !== 'allowed') { setTransitions(null); setTransitionBlocks([]); return }
    setTransitions({ state: 'loading' })
    setTransitionBlocks([])
    const response = await read({ key: 'transitions', call: { op: 'listTransitions', itemId: here.target.itemId }, origin: here })
    if (response === null) return
    setTransitions(response.ok && response.result.op === 'listTransitions' ? { state: 'ready', value: response.result.statusKeys } : { state: 'error', message: response.ok ? '출처 응답 모양이 다릅니다.' : response.error.message })
    setTransitionBlocks(response.ok && response.result.op === 'listTransitions' ? response.result.blocked : [])
  }, [here, caps, read])

  /** 키 링크·연결 행 → 그 작업 상세. 키만 아는 것은 출처에서 찾는다. */
  const openKey = useCallback(async (key: string): Promise<void> => {
    if (here === null) return
    const response = await read({ key: 'find', call: { op: 'findByKey', key }, origin: here })
    if (response === null) return
    if (response.ok && response.result.op === 'findByKey' && response.result.item !== null) page.setSelectedId(itemUid({ connectionId: here.target.connectionId, itemId: response.result.item.id }))
    else notify({ kind: 'failed', message: response.ok ? `${key} — 작업을 찾지 못했습니다.` : `${key} — ${response.error.message}` })
  }, [here, read, page, notify])
  const openItem = useCallback((itemId: string) => {
    if (target !== null) page.setSelectedId(itemUid({ connectionId: target.connectionId, itemId }))
  }, [target, page])

  const commentsGate = useMemo(() => gateOf(caps?.comments), [caps])

  return {
    target, uid, session, item, base, phase, statuses, parents, children, comments, history, records, conflict, transitions, transitionBlocks,
    caps, descriptor, connection, blocked, busy, commentsGate, canReload,
    write, finalOf, versionOf, reloadFromServer, refreshLinks, overrideConflict, loadTransitions, openKey, openItem, lookupKey, holdBasis, dropBasis,
  }
}

export type TaskDetailModel = ReturnType<typeof useTaskDetail>
