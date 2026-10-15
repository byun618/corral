// 작업 상세 (LIFE-602) — 순수 함수. 화면(TaskDetail)·상태(useTaskDetail)는 이것을 부른다.
//
// - 상태 메뉴: 상태 변경 방식 `any` 면 그 스페이스 전체 상태, `allowed` 면 허용 전이 + 지금 상태. 완료 분류는 「완료함 / 취소함」 두 행.
//   분류가 내려가는 항목은 「되돌리기」 꼬리 — 고르면 확인 팝오버(C2).
// - 충돌 칸: 연 시점(서버가 마지막으로 인정한) 값과 충돌 오류가 실어 온 서버 현재 값을 **칸 값**으로 비교한다(`updatedAt` 하나로 짐작하지 않는다, G9).
// - 활동: corral 기록 + 출처 이력 + 코멘트를 시간순(최신 위)으로 합친다. 출처 이력 중 corral 기록과 **쓰기 id 가 같은 줄만** 뺀다 —
//   다른 쪽이 같은 칸을 같은 값으로 바꾼 이력(쓰기 id 없음·다름)은 지우지 않는다(G10).
import type {
  WorkActivityChange,
  WorkActivityRecord,
  WorkCategory,
  WorkComment,
  WorkHistoryEntry,
  WorkHistoryField,
  WorkItem,
  WorkPlacement,
  WorkPriority,
  WorkRelationKind,
  WorkResolution,
  WorkResolutionChoice,
  WorkStatus,
} from '../../shared/work.js'
import { PRIORITY_LABEL } from './tasks-model.js'

export const CATEGORY_RANK: Record<WorkCategory, number> = { todo: 0, in_progress: 1, done: 2 }

export const RELATION_LABEL: Record<WorkRelationKind, string> = { is_blocked_by: '막힘', blocks: '막음', duplicates: '중복', is_duplicated_by: '중복됨', relates_to: '관련' }

export const RESOLUTION_LABEL: Record<WorkResolutionChoice, string> = { completed: '완료함', cancelled: '취소함' }

export type StatusMenuRow = {
  statusKey: string
  /** 완료 분류 행만 — 완료함·취소함. */
  resolution: WorkResolutionChoice | null
  label: string
  category: WorkCategory
  /** 분류가 내려간다 — 확인 팝오버를 거친다. */
  back: boolean
  current: boolean
}

/** 상태 메뉴 행 — `allowed` 가 null 이면 전체(`any`), 배열이면 그 상태들 + 지금 상태만. */
export function statusMenuRows({ statuses, item, allowed }: { statuses: WorkStatus[]; item: Pick<WorkItem, 'statusKey' | 'category' | 'resolution'>; allowed: string[] | null }): StatusMenuRow[] {
  const ordered = [...statuses].sort((a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] || a.order - b.order)
  const shown = allowed === null ? ordered : ordered.filter((status) => status.key === item.statusKey || allowed.includes(status.key))
  const doneCount = ordered.filter((status) => status.category === 'done').length
  const rank = CATEGORY_RANK[item.category]
  return shown.flatMap((status): StatusMenuRow[] => {
    const back = CATEGORY_RANK[status.category] < rank
    if (status.category !== 'done') return [{ statusKey: status.key, resolution: null, label: status.label, category: status.category, back, current: status.key === item.statusKey }]
    return (['completed', 'cancelled'] as const).map((resolution) => ({
      statusKey: status.key,
      resolution,
      label: doneCount > 1 ? `${status.label} · ${RESOLUTION_LABEL[resolution]}` : RESOLUTION_LABEL[resolution],
      category: status.category,
      back,
      current: status.key === item.statusKey && item.resolution === resolution,
    }))
  })
}

/** 상태 버튼 글 — 완료 분류는 갈래를 붙인다(취소함만 · 갈래가 비었거나 다른 값이면 상태 이름만, G12). */
export function statusText({ status, item }: { status: WorkStatus | null; item: Pick<WorkItem, 'category' | 'resolution'> }): string {
  const label = status?.label ?? '알 수 없는 상태'
  return item.category === 'done' && item.resolution === 'cancelled' ? `${label} · 취소함` : label
}

/** 진행 중 원의 채움 — 같은 분류 안의 위치. */
export function statusFill({ statuses, statusKey }: { statuses: WorkStatus[]; statusKey: string }): number {
  const doing = statuses.filter((status) => status.category === 'in_progress').sort((a, b) => a.order - b.order)
  const index = doing.findIndex((status) => status.key === statusKey)
  return index < 0 ? 0.5 : (index + 1) / (doing.length + 1)
}

// --- 충돌 (C8) ---

export const CONFLICT_FIELD_LABEL = { title: '제목', body: '본문', status: '상태', priority: '우선순위', dueAt: '마감', placement: '배치', parent: '부모' } as const
export type ConflictField = keyof typeof CONFLICT_FIELD_LABEL

/** 연 시점 값과 서버 현재 값이 다른 칸 — 칸 값 비교. 같은 값이면 충돌 칸이 아니다. */
export function conflictFields({ base, current }: { base: WorkItem; current: WorkItem }): ConflictField[] {
  const fields: ConflictField[] = []
  if (base.title !== current.title) fields.push('title')
  if ((base.body ?? '') !== (current.body ?? '')) fields.push('body')
  if (base.statusKey !== current.statusKey || base.resolution !== current.resolution) fields.push('status')
  if (base.priority !== current.priority) fields.push('priority')
  if (dueMs(base.dueAt) !== dueMs(current.dueAt)) fields.push('dueAt')
  if (base.placement !== current.placement) fields.push('placement')
  if (base.parentId !== current.parentId) fields.push('parent')
  return fields
}

function dueMs(value: string | null): number | null {
  if (value === null) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

// --- 마감 (C3) ---

/** ISO → 날짜 칸 값(로컬 YYYY-MM-DD). */
export function dueInputValue(dueAt: string | null): string {
  if (dueAt === null) return ''
  const date = new Date(dueAt)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 날짜 칸 값 → ISO(UTC). 그날 로컬 23:59:59 — 「그날까지」. 빈 값은 null(지움), 모양이 아니면 undefined(보내지 않는다). */
export function dueFromInput(value: string): string | null | undefined {
  if (value === '') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return undefined
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

// --- 연결 묶음 (C6) ---

export const RELATION_ORDER: WorkRelationKind[] = ['is_blocked_by', 'blocks', 'duplicates', 'is_duplicated_by', 'relates_to']

/** 키 입력 검사 — 출처 키 모양(전체 일치)·자기 자신. 통과면 대문자 키, 아니면 오류 문구. 키 모양을 모르면 모양 검사는 출처에 맡긴다. */
export function checkRelationKey({ input, selfKey, keyPattern }: { input: string; selfKey: string; keyPattern: string | null }): { ok: true; key: string } | { ok: false; message: string } {
  const key = input.trim()
  if (key.length === 0) return { ok: false, message: '연결할 작업 키를 넣으세요.' }
  if (key.toUpperCase() === selfKey.toUpperCase()) return { ok: false, message: '자기 자신과는 연결할 수 없습니다.' }
  if (keyPattern !== null) {
    let whole: RegExp | null = null
    try {
      whole = new RegExp(`^(?:${keyPattern})$`, 'i')
    } catch {
      whole = null
    }
    if (whole !== null && !whole.test(key)) return { ok: false, message: `작업 키 모양이 아닙니다 (${key.slice(0, 40)}).` }
  }
  return { ok: true, key: key.toUpperCase() }
}

// --- 활동 (C9·C10) ---

export const ACTIVITY_FILTERS = ['all', 'agent', 'run', 'change', 'comment'] as const
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]
export const ACTIVITY_FILTER_LABEL: Record<ActivityFilter, string> = { all: '전체', agent: '에이전트', run: '실행', change: '변경', comment: '코멘트' }

export type ActivityRow =
  | { kind: 'change'; id: string; at: number; who: string; text: string; origin: 'corral' | 'source' }
  | { kind: 'comment'; id: string; at: number; who: string; body: string }
  /** LIFE-603 C13 — 에이전트 · 실행 갈래(main 이 링크된 worktree 를 보고 남긴 기록). `quote` = 질문 본문(있을 때만). */
  | { kind: 'agent' | 'run'; id: string; at: number; who: string; text: string; quote: string | null }

const HISTORY_FIELD_LABEL: Record<WorkHistoryField, string> = { status: '상태', title: '제목', body: '본문', priority: '우선순위', dueAt: '마감', placement: '배치', parent: '부모', relation: '연결', child: '자식' }

function priorityText(priority: WorkPriority | null): string {
  return priority === null ? '없음' : PRIORITY_LABEL[priority]
}

function placementText(placement: WorkPlacement): string {
  return placement === 'board' ? '보드' : '백로그'
}

function dueText(value: string | null): string {
  const shown = dueInputValue(value)
  return shown === '' ? '없음' : shown
}

function resolutionSuffix(resolution: WorkResolution | null): string {
  return resolution === 'cancelled' ? ' · 취소함' : resolution === 'completed' ? ' · 완료함' : ''
}

/** corral 기록 한 줄의 글. 상태 라벨을 기록 때 몰랐으면 지금 상태 목록에서 찾는다. */
export function describeChange({ change, statuses }: { change: WorkActivityChange; statuses: WorkStatus[] }): string {
  switch (change.field) {
    case 'status': {
      const label = change.statusLabel ?? statuses.find((status) => status.key === change.statusKey)?.label ?? '다른 상태'
      return `상태 → ${label}${resolutionSuffix(change.resolution)}`
    }
    case 'title': return `제목 → 「${change.to}」`
    case 'body': return `본문을 고쳤습니다 (${change.lines}줄)`
    case 'priority': return `우선순위 → ${priorityText(change.to)}`
    case 'dueAt': return `마감 → ${dueText(change.to)}`
    case 'placement': return `배치 → ${placementText(change.to)}`
    case 'parent': return change.parentId === null ? '부모를 뗐습니다' : '부모를 바꿨습니다'
    case 'relation': {
      const what = `${change.kind === null ? '' : `${RELATION_LABEL[change.kind]} `}${change.otherKey ?? ''}`.trim()
      return change.action === 'add' ? `연결 추가 · ${what}` : `연결 뗌${what === '' ? '' : ` · ${what}`}`
    }
    case 'child': return `자식 추가 · ${change.childKey} ${change.childTitle}`
    case 'run': return describeRun(change)
    case 'agent': return describeAgent(change)
  }
}

const tail = (path: string): string => path.split('/').filter((part) => part.length > 0).pop() ?? path

function describeRun(change: Extract<WorkActivityChange, { field: 'run' }>): string {
  switch (change.event) {
    case 'start': return `작업 시작 · ${change.branch} · ${change.agent === 'shell' ? '빈 터미널' : change.agent}${change.model === null ? '' : ` · ${change.model}`}`
    case 'auto_link': return `worktree 자동 연결 · ${change.branch ?? tail(change.worktree)}`
    case 'detach': return `worktree 떼기 · ${change.branch ?? tail(change.worktree)}`
    case 'source_link_failed': return `출처에 링크를 남기지 못함 · ${tail(change.worktree)}${change.message === null ? '' : ` — ${change.message}`}`
  }
}

const OUTCOME_LABEL: Record<'completed' | 'interrupted' | 'failed', string> = { completed: '완료', interrupted: '중단', failed: '실패' }

function describeAgent(change: Extract<WorkActivityChange, { field: 'agent' }>): string {
  const who = change.agent ?? '에이전트'
  switch (change.event) {
    case 'question': return change.question === null ? `${who} · 질문 대기 (${change.noBody ?? '본문 없음'})` : `${who} · 질문 대기`
    case 'result': {
      const files = change.filesChanged === null ? '' : ` · 바뀐 파일 ${change.filesChanged}`
      return `${who} · 턴 ${OUTCOME_LABEL[change.outcome]}${change.detail === null ? '' : ` (${change.detail})`}${files} · ${tail(change.worktree)}`
    }
  }
}

function describeHistory(entry: WorkHistoryEntry): string {
  const label = HISTORY_FIELD_LABEL[entry.field]
  if (entry.field === 'body') return '본문을 고쳤습니다'
  if (entry.from === null && entry.to !== null) return `${label} · ${entry.to}`
  if (entry.to === null && entry.from !== null) return `${label} 뗌 · ${entry.from}`
  return `${label}: ${entry.from ?? '—'} → ${entry.to ?? '—'}`
}

/** 시간순 합침(최신이 위). 출처 이력 중 corral 기록과 쓰기 id 가 같은 줄만 뺀다. */
export function activityRows({ records, history, comments, statuses, sourceName }: {
  records: WorkActivityRecord[]
  history: WorkHistoryEntry[]
  comments: WorkComment[]
  statuses: WorkStatus[]
  sourceName: string
}): ActivityRow[] {
  const ours = new Set(records.map((record) => record.writeId))
  const rows: ActivityRow[] = [
    ...records.map((record): ActivityRow => {
      const text = describeChange({ change: record.change, statuses })
      if (record.change.field === 'agent') return { kind: 'agent', id: `a:${record.id}`, at: record.at, who: 'corral', text, quote: record.change.event === 'question' ? record.change.question : null }
      if (record.change.field === 'run') return { kind: 'run', id: `a:${record.id}`, at: record.at, who: '나 · corral', text, quote: null }
      return { kind: 'change', id: `a:${record.id}`, at: record.at, who: '나 · corral', text, origin: 'corral' }
    }),
    ...history
      .filter((entry) => entry.writeId === null || !ours.has(entry.writeId))
      .map((entry): ActivityRow => ({ kind: 'change', id: `h:${entry.id}`, at: Date.parse(entry.at) || 0, who: `${entry.author ?? '다른 곳'} · ${sourceName}`, text: describeHistory(entry), origin: 'source' })),
    ...comments.map((comment): ActivityRow => ({ kind: 'comment', id: `c:${comment.id}`, at: Date.parse(comment.createdAt) || 0, who: `${comment.author ?? '알 수 없음'} · ${sourceName}`, body: comment.body })),
  ]
  return rows.sort((a, b) => b.at - a.at)
}

export function activityCounts(rows: ActivityRow[]): Record<ActivityFilter, number> {
  return {
    all: rows.length,
    agent: rows.filter((row) => row.kind === 'agent').length,
    run: rows.filter((row) => row.kind === 'run').length,
    change: rows.filter((row) => row.kind === 'change').length,
    comment: rows.filter((row) => row.kind === 'comment').length,
  }
}

export function passesActivity({ row, filter }: { row: ActivityRow; filter: ActivityFilter }): boolean {
  switch (filter) {
    case 'all': return true
    case 'change': return row.kind === 'change'
    case 'comment': return row.kind === 'comment'
    case 'agent': return row.kind === 'agent'
    case 'run': return row.kind === 'run'
  }
}

/** 「몇 분 전」 — 활동·충돌 배너의 언제. */
export function relativeTime({ at, now }: { at: number; now: number }): string {
  const diff = Math.max(0, now - at)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '방금'
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}일 전`
  const date = new Date(at)
  return `${date.getMonth() + 1}/${date.getDate()}`
}
