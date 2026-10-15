// 작업 페이지 (LIFE-601 · LIFE-372 묶음 T2) — 메인 영역만 덮는 페이지. 사이드바는 덮지 않는다(핸드오프 Q1 1a).
//
// - 열고 닫기는 App 이 한다(사이드바 「작업」·⌘I). 이 컴포넌트는 처음 열 때 마운트되고 **닫혀도 마운트를 유지**한다 —
//   닫힌 동안은 `visibility:hidden` + `inert`. 그래서 검색어·스크롤·펼침이 같은 실행 안에서 그대로 남는다(C3). 재시작 뒤 복원은 ui-prefs.
// - 키(C4): `/` 검색 · `1`–`4` 보기(입력 중이면 글자) · `Esc` 단계 = 열린 메뉴 → 입력 blur → 페이지 닫기. IME 조합 중 Esc 는 조합만 끝낸다.
//   `C`(만들기, LIFE-604)는 단축키 레지스트리가 아니라 이 페이지 처리기 몫이다(수정키 없는 키 — F9). 페이지가 열린 동안 워크스페이스 단축키는 App 이 막는다.
//   페이지 키는 **페이지 안(또는 포커스 없음)에서 난 키만** 받고, 위층(설정·팔레트·모달)이 열려 있으면(`yieldKeys`) 하나도 받지 않는다(R1-G).
// - LIFE-604 만들기 진입점 — 머리 「만들기」 · `C` · 보드 칸 「+ 추가」(인라인) · 백로그 섹션 「추가」. 쓰기가 막히면 흐림 + 이유, `C` 는 안 열림.
//   만들기·시작 모달이 열린 동안 페이지 키(`C`·`/`·`1–4`)는 받지 않는다(F10).
// - LIFE-602 — 카드·행·검색 결과를 누르면 그 작업 상세(`TaskDetail`)가 오른쪽 패널로 열린다(선택 = 열린 상세, 다시 누르면 닫힘).
//   `Esc` 단계 = 열린 메뉴 → 상세의 메뉴·확인 팝오버 → 입력 blur → 상세 닫기 → 페이지 닫기.
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { RepoRow } from '../../../shared/types.js'
import type { WorkCapabilities, WorkItem, WorkPriority, WorkStatus } from '../../../shared/work.js'
import { WORK_PRIORITIES } from '../../../shared/work.js'
import { useTaskDrag, type TaskDrop } from '../hooks/useTaskDrag.js'
import { DETAIL_READING, useTasksPage, type MoveNotice } from '../hooks/useTasksPage.js'
import { useTaskDetail } from '../hooks/useTaskDetail.js'
import {
  NO_FILTERS,
  PRIORITY_LABEL,
  TASKS_VIEWS,
  TASKS_VIEW_LABEL,
  activePreset,
  applyPreset,
  boardBands,
  boardDropIntent,
  compareRank,
  emptyCause,
  filtersActive,
  itemUid,
  groupRows,
  imeComposing,
  parseUid,
  passesFilters,
  passesText,
  rowUid,
  sortRows,
  spaceId,
  viewDisabledReason,
  viewsFor,
  workingTextMatches,
  writeBlock,
  type BoardColumn,
  type DragIntent,
  type EmptyCause,
  type TasksFilters,
  type TasksGroup,
  type TasksRow,
  type TasksView,
  type WorkingTree,
} from '../tasks-model.js'
import './tasks.css'
import './task-detail.css'
import './work-links.css'
import { TaskDetail } from './TaskDetail.js'
import { StartWorkModal } from './StartWorkModal.js'
import { WorkLinksContext, type DetailWorkActions, type WorkLinksView } from './WorkLinkChips.js'
import { useStartWork } from '../hooks/useStartWork.js'
import { treesFor } from '../work-links-model.js'
import type { WorkRepoDefault } from '../../../shared/work.js'
import { InlineAddSlot, QuickCreateModal } from './QuickCreate.js'
import { useQuickCreate } from '../hooks/useQuickCreate.js'

/** 사이드바 작업 줄이 여는 작업 — `itemId` 를 모르면(자동 링크) 키로 찾는다. */
export type TasksFocus = { seq: number; connectionId: string; itemId: string | null; key: string }

const NO_DEFAULTS: WorkRepoDefault[] = []
import { Backlog, Board, ListView, MoreBar, SpaceDot, WorkingList, capabilityGate, type CardProps, type ColumnDragView, type MoreState, type WorkingView } from './TasksViews.js'

type BacklogSection = { id: 'board' | 'backlog'; label: string; rows: TasksRow[] }

const IDLE: ColumnDragView = { mode: 'idle', reason: null }
const NO_TRANSITION = '워크플로에 이 전이가 없습니다'
const BUSY = '앞 변경을 출처가 확인하는 중…'

const EMPTY_COPY: Record<EmptyCause, { title: string; body: string }> = {
  space: { title: '이 스페이스는 비어 있습니다', body: '출처에서 작업을 만들면 여기에 나타납니다.' },
  search: { title: '검색 결과 없음', body: '다른 낱말이나 키로 찾아보세요.' },
  filter: { title: '필터에 맞는 작업이 없습니다', body: '필터를 지우면 다시 보입니다.' },
  working: { title: '작업 중인 worktree 가 없습니다', body: '브랜치 이름에 작업 키가 들어간 worktree 를 열면 여기에 모입니다.' },
}

export function TasksPage({ open, repos, activeRepoRoot, shortcut, yieldKeys, onClose, onOpenSettings, onOpenWorktree, unreadPanes, onRevealPane, focus }: {
  open: boolean
  repos: RepoRow[]
  activeRepoRoot: string | null
  shortcut: string | null
  /** 위층(설정·팔레트·모달)이 열려 있다 — 페이지 키 처리기가 아무 키도 받지 않는다(R1-G). */
  yieldKeys: boolean
  onClose: () => void
  onOpenSettings: () => void
  /** 작업 중 줄 · 칩 · 「열기」 · 시작 모달의 「worktree 열기」 — 모두 같은 경로(C1). */
  onOpenWorktree: (tree: Pick<WorkingTree, 'repoRoot' | 'path'>) => void
  /** 사이드바와 같은 안 읽음 pane 집합 — 링크된 worktree 점(LIFE-603 C10). */
  unreadPanes?: ReadonlySet<string>
  /** 「터미널에서 답하기」 — 페이지를 닫고 그 pane 으로. */
  onRevealPane?: (paneId: string) => void
  /** 사이드바 작업 줄 클릭 — 그 작업 상세를 연다(`seq` 가 바뀔 때마다 한 번). */
  focus?: TasksFocus | null
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [menu, setMenu] = useState<'space' | 'kind' | 'priority' | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // 상대 시간(작업 중 보기·마감)은 열린 동안 분 단위로 흐른다(R2-P).
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [open])

  const notify = (notice: MoveNotice): void => {
    switch (notice.kind) {
      case 'moved': {
        const id = toast(
          <div className="tasks-toast" data-toast="moved">
            <span className="tasks-toast-label">{notice.label}</span>
            <button type="button" className="tasks-toast-undo" data-toast-undo="" onClick={() => { if (notice.undo()) toast.dismiss(id) }}>되돌리기</button>
          </div>,
          { duration: 6000 },
        )
        notice.bind?.(() => toast.dismiss(id))
        return
      }
      case 'undone':
        toast(<div className="tasks-toast" data-toast="undone">{notice.label}</div>, { duration: 4000 })
        return
      case 'failed':
        toast(<div className="tasks-toast is-error" data-toast="failed">{notice.message}</div>, { duration: 6000 })
        return
      case 'delayed':
        toast(<div className="tasks-toast" data-toast="delayed">{notice.message}</div>, { duration: 6000 })
        return
      case 'final':
        toast(<div className="tasks-toast" data-toast="final">{notice.label}</div>, { duration: 6000 })
        return
    }
  }
  const page = useTasksPage({ open, repos, activeRepoRoot, notify, unreadPanes })
  const { prefs, setPrefs, space, settings, groups, load, rows, banner, query, setQuery, selectedId, setSelectedId } = page
  const all = space?.kind === 'all'

  // --- 상세 (LIFE-602) ---
  const detailTarget = useMemo(() => (selectedId === null ? null : parseUid(selectedId)), [selectedId])
  const detail = useTaskDetail({ open, target: detailTarget, page, notify })
  const detailEscape = useRef<(() => boolean) | null>(null)

  // --- 작업에서 시작 · 링크 (LIFE-603) ---
  const links = useMemo((): WorkLinksView => ({ trees: page.linked, open: onOpenWorktree }), [page.linked, onOpenWorktree])
  const detailSource = detail.descriptor?.name ?? detail.connection?.name ?? '출처'
  const starter = useStartWork({ detail, repos, repoDefaults: settings?.repoDefaults ?? NO_DEFAULTS, activeRepoRoot, sourceName: detailSource, notifyFailure: (message) => notify({ kind: 'failed', message }) })
  const detailTrees = detail.item === null || detailTarget === null ? [] : treesFor({ trees: page.linked, connectionId: detailTarget.connectionId, itemId: detail.item.id, key: detail.item.key })
  const workActions = useMemo((): DetailWorkActions => ({ start: (mode) => starter.begin(mode), reveal: (paneId) => onRevealPane?.(paneId) }), [starter.begin, onRevealPane])
  // 사이드바 작업 줄 → 그 작업 상세. 작업 id 를 모르면(자동 링크) 키로 한 번 찾는다.
  const focusSeq = focus?.seq ?? 0
  useEffect(() => {
    if (focus == null || !open) return
    if (focus.itemId !== null) { setSelectedId(itemUid({ connectionId: focus.connectionId, itemId: focus.itemId })); return }
    let live = true
    void window.corral.workRequest({ requestId: `focus-${focus.seq}-${Date.now()}`, connectionId: focus.connectionId, call: { op: 'findByKey', key: focus.key } }).then((response) => {
      if (!live || !response.ok || response.result.op !== 'findByKey' || response.result.item === null) return
      setSelectedId(itemUid({ connectionId: focus.connectionId, itemId: response.result.item.id }))
    })
    return () => { live = false }
  }, [focusSeq, open])
  /** 스페이스 키 → 이름·색 — 보이는 스페이스면 그 색 번호, 숨긴 스페이스도 설정 목록에서 이름을 찾는다. */
  const spaceOf = (spaceKey: string): { name: string; color: string | null; index: number } | null => {
    if (detailTarget === null) return null
    const row = groups.flatMap((group) => group.rows).find((entry) => entry.connectionId === detailTarget.connectionId && entry.key === spaceKey)
    if (row !== undefined) return { name: row.name, color: row.color, index: row.colorIndex }
    const spaces = settings?.connections.find((connection) => connection.id === detailTarget.connectionId)?.spaces ?? []
    const at = spaces.findIndex((entry) => entry.key === spaceKey)
    const known = spaces[at]
    return known === undefined ? null : { name: known.name, color: known.color, index: (at % 7) + 1 }
  }

  // --- 능력 ---
  const capsOf = (connectionId: string): WorkCapabilities | null => settings?.connections.find((connection) => connection.id === connectionId)?.capabilities ?? null
  const shownCaps = useMemo(() => {
    if (settings === null || space === null) return []
    const ids = space.kind === 'all' ? settings.connections.map((connection) => connection.id) : [space.connectionId]
    return ids.flatMap((id) => {
      const caps = settings.connections.find((connection) => connection.id === id)?.capabilities
      return caps === null || caps === undefined ? [] : [caps]
    })
  }, [settings, space])
  const views = viewsFor(shownCaps)
  const viewReason = (entry: TasksView): string | null => viewDisabledReason({ capabilities: shownCaps, view: entry })
  const view: TasksView = views.includes(prefs.view) && viewReason(prefs.view) === null ? prefs.view : 'board'

  // --- 거르기 ---
  const passes = (item: WorkItem): boolean => passesFilters({ item, filters: prefs.filters, workingKeys: page.workingKeys, now })
  // 키 일치(E2) — 필터를 우회하지 않고(R1-I), 정확히 그 키인 작업은 맨 앞 영역으로 옮기고 나머지 목록에서 뺀다(R1-J).
  const hits = page.hits.filter((hit) => passes(hit.item))
  const hitUids = new Set(hits.map((hit) => itemUid({ connectionId: hit.connectionId, itemId: hit.item.id })))
  const filtered = useMemo(
    () => rows.filter((row) => passes(row.item) && passesText({ item: row.item, query }) && !hitUids.has(rowUid(row))),
    [rows, prefs.filters, page.workingKeys, now, query, page.hits],
  )
  const afterFilter = useMemo(() => rows.filter((row) => passes(row.item)).length, [rows, prefs.filters, page.workingKeys, now])
  const statuses: WorkStatus[] = load.data.length === 1 ? (load.data[0]?.statuses ?? []) : []
  const kinds = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of load.data) for (const kind of entry.kinds) map.set(kind.key, kind.label)
    return [...map.entries()].map(([key, label]) => ({ key, label }))
  }, [load.data])

  // --- 작업 중 ---
  // 스페이스 범위 → 공통 필터(R1-I) → 글자 거르기 순으로 세 단계를 나눠 센다 — 빈 상태 원인(작업 중 없음 vs 필터 vs 검색)을 가린다(R2-H·R3-H).
  // 「전체」 에서도 숨긴 스페이스(보이는 스페이스 목록에 없는 곳)의 작업은 뺀다(R3-G, C2). 아직 못 찾은 항목은 스페이스를 모르니 연결만 본다.
  const visibleSpaces = new Set(groups.flatMap((group) => group.rows.map((entry) => `${entry.connectionId}::${entry.key}`)))
  const workingInSpace: WorkingView[] = page.workingEntries.flatMap((entry) => {
    const lookup = page.working.get(`${entry.connectionId}::${entry.key}`) ?? { state: 'loading' }
    if (space === null) return []
    if (space.kind === 'space') {
      if (entry.connectionId !== space.connectionId) return []
      if (lookup.state === 'found' && lookup.item.spaceKey !== space.spaceKey) return []
    } else if (lookup.state === 'found' && !visibleSpaces.has(`${entry.connectionId}::${lookup.item.spaceKey}`)) {
      return []
    }
    return [{ entry, lookup }]
  })
  // 같은 필터(R1-I) — 작업을 찾았으면 그 작업으로, 아직 못 찾았으면(찾는 중·없음·실패) 「작업 중」 밖의 필터가 켜져 있을 때 뺀다.
  const workingScoped = workingInSpace.filter(({ lookup }) => (lookup.state === 'found' ? passes(lookup.item) : !filtersActive({ ...prefs.filters, working: false })))
  const workingAfterFilter = workingScoped.length
  // 글자 거르기 — 찾은 작업은 키·제목으로, 아직 못 찾은 항목(찾는 중·없음·실패)은 키·브랜치로(R2-H). 키 일치 결과는 위에 따로 보인다
  // (작업 중 항목은 worktree 열기 버튼을 갖고 있어 겹쳐도 빼지 않는다).
  const workingViews = workingScoped.filter(({ entry, lookup }) => (lookup.state === 'found'
    ? passesText({ item: lookup.item, query })
    : workingTextMatches({ key: entry.key, branches: entry.trees.map((tree) => tree.branch), query })))

  // --- 끌기 (C7·C8) ---
  const writeBlockOf = (connectionId: string): string | null => {
    const status = settings?.connections.find((connection) => connection.id === connectionId)?.status ?? null
    if (banner !== null && (banner.kind === 'forbidden' || banner.kind === 'offline' || banner.kind === 'auth')) return writeBlock(banner.kind === 'offline' ? 'offline' : banner.kind)?.reason ?? null
    return writeBlock(status)?.reason ?? null
  }
  // --- 만들기 (LIFE-604) ---
  const creator = useQuickCreate({
    page,
    space,
    writeBlockOf,
    openItem: (target) => setSelectedId(itemUid(target)),
    notifyFailure: (message) => notify({ kind: 'failed', message }),
    onCreated: ({ connectionId, item }) => {
      const uid = itemUid({ connectionId, itemId: item.id })
      const id = toast(
        <div className="tasks-toast" data-toast="created">
          <span className="tasks-toast-label">{item.key} 를 만들었습니다</span>
          <button type="button" className="tasks-toast-undo" data-toast-open="" onClick={() => { setSelectedId(uid); toast.dismiss(id) }}>열기</button>
        </div>,
        { duration: 6000 },
      )
    },
  })
  const createBlocked = creator.blockedReason()
  // 페이지가 닫히면 만들기 모달·인라인 입력도 닫는다 — 보이지 않는 모달이 앱의 Esc 를 가로채지 않게(R1-I). 글은 초안으로 남는다.
  const closeCreate = creator.close
  const closeInline = creator.closeInline
  useEffect(() => {
    if (open) return
    closeCreate()
    closeInline()
  }, [open, closeCreate, closeInline])

  // 끄는 행 — 끌기 id 는 `(연결, 작업 id)`(R1-L). 놓기 판정은 이 행을 **인자로** 받는다(R1-A: 놓기 전에 지우면 판정이 idle 로 끝났다).
  const dragRow = useRef<TasksRow | null>(null)
  const { drag, onMouseDown } = useTaskDrag({
    rootRef,
    // 페이지가 닫히거나 위층(설정·팔레트·모달)이 열리면 끄는 중이라도 취소한다(R2-K).
    active: open && !yieldKeys,
    scope: space === null ? '' : spaceId(space),
    onStart: (uid) => {
      const row = rows.find((entry) => rowUid(entry) === uid) ?? null
      dragRow.current = row
      if (row !== null) void page.beginDrag(row, capsOf(row.space.connectionId)?.transition.mode ?? 'any')
    },
    onEnd: () => page.endDrag(),
    onDrop: (drop) => {
      const row = dragRow.current
      if (row !== null) commitDrop({ row, drop })
      dragRow.current = null
    },
  })
  // 확인 안 된 쓰기가 있는 카드·상세가 다시 받는 중인 카드는 잠근다 — 손잡이 흐림 + 이유(R2-A · R6-D).
  const lockOf = (row: TasksRow): string | null => writeBlockOf(row.space.connectionId) ?? (page.busy.has(rowUid(row)) ? BUSY : null) ?? (page.reading.has(rowUid(row)) ? `${DETAIL_READING}…` : null)
  const handleOf = (row: TasksRow): CardProps['handle'] => ({
    blocked: lockOf(row),
    onMouseDown: (event) => onMouseDown(rowUid(row), event, lockOf(row)),
  })
  /** 상태 전이 막힘 이유 — 허용 전이만인 출처는 그 작업의 허용 전이를 **받은 뒤에만** 연다(받는 중·실패 = 흐림, fail-closed). */
  const transitionBlock = (row: TasksRow, statusKey: string): string | null => {
    if (capsOf(row.space.connectionId)?.transition.mode !== 'allowed' || statusKey === row.item.statusKey) return null
    const known = page.transitions
    if (known === null || known.uid !== rowUid(row) || known.state === 'loading') return '허용 전이를 받는 중…'
    if (known.state === 'error') return `허용 전이를 받지 못했습니다 — ${known.message}`
    return known.keys.includes(statusKey) ? null : NO_TRANSITION
  }
  const statusesOf = (row: TasksRow): WorkStatus[] => row.space.statuses
  const columnView = (column: BoardColumn): ColumnDragView => (dragRow.current === null ? IDLE : columnViewFor({ row: dragRow.current, column }))
  const columnViewFor = ({ row, column }: { row: TasksRow; column: BoardColumn }): ColumnDragView => {
    const intent = boardDropIntent({ row, column, afterId: null, statusesOf })
    switch (intent.kind) {
      case 'none':
        return { mode: 'blocked', reason: column.unmapped ? '칸 없는 상태로는 옮길 수 없습니다' : NO_TRANSITION }
      case 'status': {
        const reason = transitionBlock(row, intent.statusKey)
        return reason === null ? { mode: 'target', reason: null } : { mode: 'blocked', reason }
      }
      case 'reorder': {
        const order = capabilityGate(capsOf(row.space.connectionId), 'order')
        if (order.state === 'on') return { mode: 'target', reason: null }
        return order.state === 'disabled' ? { mode: 'blocked', reason: `순서를 바꿀 수 없습니다 — ${order.reason}` } : { mode: 'source', reason: null }
      }
      case 'placement':
        return IDLE
    }
  }
  const sectionView = (id: 'board' | 'backlog'): ColumnDragView => (dragRow.current === null ? IDLE : sectionViewFor({ row: dragRow.current, id }))
  const sectionViewFor = ({ row, id }: { row: TasksRow; id: 'board' | 'backlog' }): ColumnDragView => {
    const same = (row.item.placement ?? 'board') === id
    const gate = capabilityGate(capsOf(row.space.connectionId), same ? 'order' : 'placement')
    if (gate.state === 'on') return { mode: 'target', reason: null }
    if (gate.state === 'hidden') return { mode: 'source', reason: null }
    return { mode: 'blocked', reason: same ? `순서를 바꿀 수 없습니다 — ${gate.reason}` : gate.reason }
  }
  /**
   * 놓인 번호 → 「이 작업 뒤로」. **같은 연결·스페이스의 작업만** 기준으로 삼는다(R2-L) — 「전체」 칸에는 다른 연결 작업이 섞여 있고,
   * 그 id 는 이 연결에서 뜻이 없다. 놓인 자리 앞의 같은 스페이스 작업이 있으면 그 뒤로, 없으면 뒤쪽 첫 같은 스페이스 작업의 (스페이스 전체 순서에서) 앞 작업, 그것도 없으면 null.
   */
  const afterIdFor = ({ row, laneRows, index }: { row: TasksRow; laneRows: TasksRow[]; index: number }): string | null => {
    const others = laneRows.filter((entry) => rowUid(entry) !== rowUid(row))
    const sameSpace = (entry: TasksRow): boolean => entry.space.connectionId === row.space.connectionId && entry.space.spaceKey === row.space.spaceKey
    const previous = others.slice(0, index).filter(sameSpace).at(-1)
    if (previous !== undefined) return previous.item.id
    const first = others.slice(index).find(sameSpace)
    if (first === undefined) return null
    const global = [...row.space.items].filter((item) => item.id !== row.item.id).sort(compareRank)
    const at = global.findIndex((item) => item.id === first.item.id)
    return at > 0 ? (global[at - 1]?.id ?? null) : null
  }
  const commitDrop = ({ row, drop }: { row: TasksRow; drop: TaskDrop }): void => {
    let intent: DragIntent = { kind: 'none' }
    if (drop.zone.startsWith('col:')) {
      const column = bands.flatMap((band) => band.columns).find((entry) => `col:${entry.id}` === drop.zone)
      if (column === undefined || columnViewFor({ row, column }).mode !== 'target') return
      const afterId = afterIdFor({ row, laneRows: column.rows, index: drop.index })
      intent = boardDropIntent({ row, column, afterId, statusesOf })
      if (intent.kind === 'reorder' && unchangedPosition({ row, laneRows: column.rows, index: drop.index })) return
    } else if (drop.zone.startsWith('sec:')) {
      const id = drop.zone === 'sec:backlog' ? 'backlog' : 'board'
      if (sectionViewFor({ row, id }).mode !== 'target') return
      const section = backlogSections.find((entry) => entry.id === id)
      if (section === undefined) return
      if ((row.item.placement ?? 'board') !== id) intent = { kind: 'placement', placement: id }
      else if (!unchangedPosition({ row, laneRows: section.rows, index: drop.index })) intent = { kind: 'reorder', afterId: afterIdFor({ row, laneRows: section.rows, index: drop.index }) }
    }
    if (intent.kind !== 'none') void page.move({ row, intent })
  }

  // --- 보기 자료 ---
  const placementHidden = shownCaps.length > 0 && shownCaps.every((caps) => caps.placement.state === 'hidden')
  const boardRows = placementHidden ? filtered : filtered.filter((row) => row.item.placement !== 'backlog')
  const bands = useMemo(() => boardBands({ rows: boardRows, statuses, all }), [boardRows, statuses, all])
  const backlogSections = useMemo((): BacklogSection[] => {
    const sorted = [...filtered].sort((a, b) => compareRank(a.item, b.item))
    return [
      { id: 'board', label: '보드', rows: sorted.filter((row) => row.item.placement !== 'backlog') },
      { id: 'backlog', label: '백로그', rows: sorted.filter((row) => row.item.placement === 'backlog') },
    ]
  }, [filtered])
  const listGroups = useMemo(() => groupRows({ rows: sortRows({ rows: filtered, sort: prefs.sort }), group: prefs.group, statuses, all }), [filtered, prefs.sort, prefs.group, statuses, all])
  const more = ((): MoreState => {
    if (load.data.some((entry) => entry.nextCursor !== null)) return { kind: 'cursor', loaded: rows.length, loading: load.loadingMore }
    const capped = load.data.find((entry) => entry.truncated)
    if (capped === undefined) return null
    const paging = capsOf(capped.connectionId)?.cursorPaging
    return { kind: 'capped', loaded: capped.items.length, reason: paging?.state === 'disabled' ? paging.reason : null }
  })()

  // --- 키 (C4) ---
  const viewsRef = useRef(views)
  viewsRef.current = views
  const overlay = creator.modal !== null || starter.open
  const latest = useRef({ menu, onClose, setPrefs, yieldKeys, viewReason, selectedId, setSelectedId, overlay, openCreate: creator.openModal })
  latest.current = { menu, onClose, setPrefs, yieldKeys, viewReason, selectedId, setSelectedId, overlay, openCreate: creator.openModal }
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || latest.current.yieldKeys) return
      // 페이지 안 모달(만들기·시작)이 열린 동안은 페이지 키가 새지 않는다(F10) — Esc 는 모달이 capture 로 먼저 받는다.
      if (latest.current.overlay) return
      const target = event.target
      // 페이지 밖(사이드바 입력·위층)에서 난 키는 그쪽 몫이다 — 포커스가 없을 때(body)만 페이지가 받는다(R1-G).
      if (target instanceof Node && target !== document.body && target !== document.documentElement && !(rootRef.current?.contains(target) ?? false)) return
      const typing = target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null)
      if (event.key === 'Escape') {
        if (imeComposing(event)) return
        event.preventDefault()
        if (latest.current.menu !== null) { setMenu(null); return }
        if (detailEscape.current?.() === true) return
        if (typing && target instanceof HTMLElement) { target.blur(); return }
        if (latest.current.selectedId !== null) { latest.current.setSelectedId(null); return }
        latest.current.onClose()
        return
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return
      // `C` = 만들기(LIFE-604). 수정키·입력 중·IME 조합·열린 메뉴·위층이면 무시, 쓰기가 막혀 있으면 열리지 않는다(openCreate 가 거절).
      // 자판 배열과 무관하게 물리 키(`KeyC`)도 받는다 — 한글 자판이면 `key` 가 `ㅊ` 다(R1-E, keybindings.ts 관례).
      // 조합은 `isComposing` 만 본다(R3-A) — 입력 칸 밖(`typing` 은 위에서 걸렀다)이라 조합 중일 수 없고, 한글 자판 keydown 은 `keyCode 229` 로 올 수 있다.
      if ((event.key === 'c' || event.key === 'C' || event.code === 'KeyC') && !event.shiftKey && !event.isComposing) {
        if (latest.current.menu !== null) return
        if (latest.current.openCreate()) event.preventDefault()
        return
      }
      if (event.key === '/') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      const digit = ['1', '2', '3', '4'].indexOf(event.key)
      if (digit >= 0) {
        const next = TASKS_VIEWS[digit]
        if (next !== undefined && viewsRef.current.includes(next) && latest.current.viewReason(next) === null) {
          event.preventDefault()
          latest.current.setPrefs({ view: next })
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  // 열면 페이지가 포커스를 받는다 — 덮인 터미널(inert)에 포커스가 남지 않게.
  useEffect(() => {
    if (open) requestAnimationFrame(() => { if (!(document.activeElement instanceof HTMLInputElement)) rootRef.current?.focus({ preventScroll: true }) })
  }, [open])

  // --- 필터 ---
  const setFilters = (filters: TasksFilters): void => {
    page.invalidateMore()
    setPrefs({ filters })
  }
  const toggleList = <T extends string>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value])
  const currentSpaceLabel = ((): { name: string; color: string | null; index: number } | null => {
    if (space === null) return null
    if (space.kind === 'all') return { name: '전체', color: null, index: 0 }
    const row = groups.flatMap((group) => group.rows).find((entry) => entry.connectionId === space.connectionId && entry.key === space.spaceKey)
    return { name: row?.name ?? load.data[0]?.spaceName ?? '스페이스', color: row?.color ?? null, index: row?.colorIndex ?? 1 }
  })()

  const toggleSelect = (uid: string): void => setSelectedId(selectedId === uid ? null : uid)

  // --- 본문 ---
  const noConnection = settings !== null && settings.connections.length === 0
  const loading = (load.phase === 'loading' && load.data.length === 0) || page.choosing
  const total = view === 'working' ? workingInSpace.length : rows.length
  const shown = view === 'working' ? workingViews.length : view === 'board' ? boardRows.length : filtered.length
  // 다음 쪽이 있으면 거른 결과가 0 이어도 빈 상태로 갈아 끼우지 않는다 — 「더 불러오기」·목록 도구가 남아야 한다(R2-M).
  const empty = !noConnection && banner === null && !loading && load.phase !== 'idle' && shown === 0 && hits.length === 0 && (view === 'working' || more?.kind !== 'cursor')
  const cause = emptyCause({ total, afterFilter: view === 'working' ? workingAfterFilter : afterFilter, query, view })

  const body = ((): React.ReactNode => {
    if (noConnection) {
      return (
        <div className="tasks-empty" data-tasks-empty="no-connection">
          <div className="tasks-empty-title">연결된 작업 출처가 없습니다</div>
          <div className="tasks-empty-body">설정 › 연결에서 토큰을 붙여넣으면 작업을 볼 수 있습니다.</div>
          <button type="button" className="tasks-empty-action" onClick={onOpenSettings}>연결 설정 열기</button>
        </div>
      )
    }
    if (loading) {
      return (
        <div className="tasks-loading" data-tasks-loading="">
          {[0, 1, 2].map((index) => <div key={index} className="tasks-skeleton-col"><span /><span /><span /></div>)}
        </div>
      )
    }
    // 오류 배너가 있으면 빈 상태를 그리지 않는다(C5) — 받은 것이 있으면 그대로 보인다.
    if (banner !== null && rows.length === 0 && view !== 'working') return null
    if (empty) {
      const copy = EMPTY_COPY[cause]
      return (
        <div className="tasks-empty" data-tasks-empty={cause}>
          <div className="tasks-empty-title">{copy.title}</div>
          <div className="tasks-empty-body">{copy.body}</div>
          {cause === 'filter' ? <button type="button" className="tasks-empty-action" onClick={() => setFilters(NO_FILTERS)}>필터 지우기</button> : null}
          {cause === 'search' ? <button type="button" className="tasks-empty-action" onClick={() => setQuery('')}>검색어 지우기</button> : null}
        </div>
      )
    }
    switch (view) {
      case 'board':
        return (
          <div className="tasks-scroll" data-tasks-scroll="board">
            {hits.length > 0 ? <KeyHits hits={hits} selectedId={selectedId} onSelect={toggleSelect} /> : null}
            <Board
              bands={bands} rows={rows} all={all} density={prefs.density} selectedId={selectedId} drag={drag} now={now} columnView={columnView} handleOf={handleOf} onSelect={(row) => toggleSelect(rowUid(row))}
              columnFooter={(column) => (column.statusKey === null ? null : <InlineAddSlot view={creator.inlineView({ statusKey: column.statusKey, columnId: column.id, unmapped: column.unmapped })} model={creator} statusKey={column.statusKey} columnId={column.id} />)}
            />
            <MoreBar more={more} onLoadMore={() => void page.loadMore()} />
          </div>
        )
      case 'backlog':
        return (
          <div className="tasks-scroll" data-tasks-scroll="backlog">
            {hits.length > 0 ? <KeyHits hits={hits} selectedId={selectedId} onSelect={toggleSelect} /> : null}
            <Backlog
              sections={backlogSections} all={all} selectedId={selectedId} drag={drag} now={now} sectionView={sectionView} handleOf={handleOf} onSelect={(row) => toggleSelect(rowUid(row))}
              sectionAdd={(id) => (
                <button
                  type="button"
                  className={`tasks-section-add${createBlocked === null ? '' : ' is-disabled'}`}
                  data-section-add={id}
                  aria-disabled={createBlocked === null ? undefined : true}
                  title={createBlocked ?? `${id === 'board' ? '보드' : '백로그'}에 새 작업`}
                  onClick={() => { if (createBlocked === null) creator.openModal({ placement: id }) }}
                >+ 추가</button>
              )}
            />
            <MoreBar more={more} onLoadMore={() => void page.loadMore()} />
          </div>
        )
      case 'list':
        return (
          <ListView
            groups={listGroups}
            all={all}
            now={now}
            selectedId={selectedId}
            sort={prefs.sort}
            group={prefs.group}
            preset={activePreset(prefs.filters)}
            defaultPreset={prefs.defaultPreset}
            groupLabel={(group: TasksGroup) => (group === 'status' ? (all ? '분류' : '상태') : group === 'priority' ? '우선순위' : '없음')}
            hits={hits}
            more={more}
            onSort={(sort) => { page.invalidateMore(); setPrefs({ sort }) }}
            onGroup={(group) => setPrefs({ group })}
            onPreset={(preset) => { page.invalidateMore(); setPrefs(applyPreset({ preset, sort: prefs.sort })) }}
            onDefaultPreset={(preset) => { setPrefs({ defaultPreset: preset }); toast(<div className="tasks-toast" data-toast="preset">리스트 기본 프리셋을 정했습니다</div>, { duration: 3000 }) }}
            onSelect={toggleSelect}
            onLoadMore={() => void page.loadMore()}
          />
        )
      case 'working':
        return (
          <div className="tasks-scroll" data-tasks-scroll="working">
            {/* 키 일치(E2)는 작업 중 보기에서도 맨 앞에 보인다(R2-H) — 다른 스페이스의 작업이어도. */}
            {hits.length > 0 ? <KeyHits hits={hits} selectedId={selectedId} onSelect={toggleSelect} /> : null}
            <WorkingList views={workingViews} now={now} onOpen={onOpenWorktree} />
          </div>
        )
    }
  })()

  return (
    <div
      ref={rootRef}
      className={`tasks-page${open ? '' : ' is-closed'}`}
      data-tasks-page=""
      data-tasks-view={view}
      data-tasks-space={space === null ? '' : spaceId(space)}
      inert={!open}
      tabIndex={-1}
      onMouseDown={(event) => { if (menu !== null && !(event.target instanceof Element && event.target.closest('[data-tasks-menu]'))) setMenu(null) }}
    >
      <div className="tasks-drag-strip" aria-hidden />
      {/* 모달이 열린 동안 뒤 페이지(머리·본문)는 inert — Tab 이 scrim 뒤 카드·「+ 추가」 에 닿지 않는다(R4-G). 모달은 그 바깥 형제. */}
      <header className="tasks-head" inert={overlay}>
        <span className="tasks-title">작업</span>
        <div className="tasks-space-anchor">
          <button type="button" className="tasks-space-btn" data-space-switch="" onClick={() => setMenu(menu === 'space' ? null : 'space')} aria-expanded={menu === 'space'}>
            {currentSpaceLabel === null ? '스페이스 없음' : (
              <>
                {currentSpaceLabel.index > 0 ? <SpaceDot color={currentSpaceLabel.color} index={currentSpaceLabel.index} /> : null}
                <span>{currentSpaceLabel.name}</span>
              </>
            )}
            <span className="tasks-caret" aria-hidden>▾</span>
          </button>
          {menu === 'space' ? (
            <div className="tasks-menu tasks-space-menu" data-tasks-menu="space" role="menu">
              <button type="button" className={`tasks-menu-row${all ? ' is-on' : ''}`} data-space-row="all" onClick={() => { page.chooseSpace({ kind: 'all' }); setMenu(null) }}>
                <span className="tasks-space-all" aria-hidden>◎</span>
                <span className="tasks-menu-name">전체</span>
              </button>
              {groups.map((group) => (
                <div key={group.connectionId} className="tasks-menu-group" data-space-connection={group.connectionId}>
                  <div className="tasks-menu-head"><span>{group.name}</span><span className="tasks-menu-sub" data-connection-sub="">{group.sub}</span></div>
                  {group.rows.length === 0 ? <div className="tasks-menu-note">{settings?.connections.find((connection) => connection.id === group.connectionId)?.spaces === null ? '스페이스를 받는 중…' : '보이는 스페이스가 없습니다'}</div> : null}
                  {group.rows.map((row) => {
                    const on = space?.kind === 'space' && space.connectionId === row.connectionId && space.spaceKey === row.key
                    return (
                      <button key={row.key} type="button" className={`tasks-menu-row${on ? ' is-on' : ''}`} data-space-row={row.key} onClick={() => { page.chooseSpace({ kind: 'space', connectionId: row.connectionId, spaceKey: row.key }); setMenu(null) }}>
                        <SpaceDot color={row.color} index={row.colorIndex} />
                        <span className="tasks-menu-name">{row.name}</span>
                        {row.repoDefault ? <span className="tasks-chip" data-repo-default-chip="">레포 기본</span> : null}
                        <span className="tasks-menu-count">{row.openCount ?? ''}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
              <div className="tasks-menu-sep" />
              <button type="button" className="tasks-menu-row is-link" data-space-settings="" onClick={() => { setMenu(null); onOpenSettings() }}>연결 · 스페이스 설정…</button>
            </div>
          ) : null}
        </div>
        <div className="tasks-views" data-tasks-views="" role="tablist">
          {views.map((entry) => {
            // 능력이 꺼진(disabled) 보기 = 흐림 + 이유(R1-O). 숨김(hidden)이면 탭이 없다(viewsFor).
            const reason = viewReason(entry)
            return (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={view === entry}
                aria-disabled={reason === null ? undefined : true}
                title={reason ?? undefined}
                className={`tasks-view-tab${view === entry ? ' is-on' : ''}${reason === null ? '' : ' is-disabled'}`}
                data-tasks-view-tab={entry}
                onClick={() => { if (reason === null) setPrefs({ view: entry }) }}
              >
                {TASKS_VIEW_LABEL[entry]}
              </button>
            )
          })}
        </div>
        <span className="tasks-head-spacer" />
        <button type="button" className="tasks-density" data-tasks-density={prefs.density} onClick={() => setPrefs({ density: prefs.density === 'detailed' ? 'compact' : 'detailed' })} title="카드 밀도">
          {prefs.density === 'detailed' ? '자세히' : '간단히'}
        </button>
        <input
          ref={searchRef}
          className="tasks-search"
          data-tasks-search=""
          type="search"
          placeholder="키 또는 제목 검색  /"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          spellCheck={false}
        />
        <button
          type="button"
          className={`tasks-create${createBlocked === null ? '' : ' is-disabled'}`}
          data-tasks-create=""
          aria-disabled={createBlocked === null ? undefined : true}
          title={createBlocked ?? '새 작업 (C)'}
          onClick={() => { if (createBlocked === null) creator.openModal() }}
        >
          <span aria-hidden>+</span><span>만들기</span><span className="tasks-create-kbd">C</span>
        </button>
        <button type="button" className="tasks-close" data-tasks-close="" onClick={onClose} title={shortcut === null ? '닫기 (Esc)' : `닫기 (Esc · ${shortcut})`} aria-label="작업 페이지 닫기">✕</button>
      </header>

      <div className="tasks-main" inert={overlay}>
      <div className="tasks-filters" data-tasks-filters="">
        <FilterMenu
          id="kind"
          label="종류"
          open={menu === 'kind'}
          onToggle={() => setMenu(menu === 'kind' ? null : 'kind')}
          options={kinds.map((kind) => ({ key: kind.key, label: kind.label }))}
          selected={prefs.filters.kinds}
          onPick={(key) => setFilters({ ...prefs.filters, kinds: toggleList(prefs.filters.kinds, key) })}
        />
        <FilterMenu
          id="priority"
          label="우선순위"
          open={menu === 'priority'}
          onToggle={() => setMenu(menu === 'priority' ? null : 'priority')}
          options={WORK_PRIORITIES.map((priority) => ({ key: priority, label: PRIORITY_LABEL[priority] }))}
          selected={prefs.filters.priorities}
          onPick={(key) => {
            const priority = WORK_PRIORITIES.find((entry): entry is WorkPriority => entry === key)
            if (priority !== undefined) setFilters({ ...prefs.filters, priorities: toggleList(prefs.filters.priorities, priority) })
          }}
        />
        <button type="button" className={`tasks-filter${prefs.filters.blocked ? ' is-on' : ''}`} data-filter="blocked" aria-pressed={prefs.filters.blocked} onClick={() => setFilters({ ...prefs.filters, blocked: !prefs.filters.blocked })}>막힘</button>
        <button type="button" className={`tasks-filter${prefs.filters.working ? ' is-on' : ''}`} data-filter="working" aria-pressed={prefs.filters.working} onClick={() => setFilters({ ...prefs.filters, working: !prefs.filters.working })}>작업 중</button>
        {prefs.filters.dueWeek ? <span className="tasks-filter is-on is-static" data-filter="due-week">이번 주 마감</span> : null}
        {filtersActive(prefs.filters) ? <button type="button" className="tasks-clear" data-clear-filters="" onClick={() => setFilters(NO_FILTERS)}>필터 지우기</button> : null}
        <span className="tasks-head-spacer" />
        {load.phase === 'loading' && load.data.length > 0 ? <span className="tasks-refreshing" data-tasks-refreshing="">새로 받는 중…</span> : null}
      </div>

      {banner === null ? null : (
        <div className={`tasks-banner is-${banner.kind}`} data-tasks-banner={banner.kind === 'error' ? 'error' : banner.kind} role="status">
          <span className="tasks-banner-dot" aria-hidden />
          <span className="tasks-banner-text">
            {banner.kind === 'auth' ? '인증에 실패했습니다' : banner.kind === 'forbidden' ? '권한이 부족합니다' : banner.kind === 'offline' ? '출처에 닿지 않습니다' : '작업을 불러오지 못했습니다'}
            {banner.message.length > 0 ? ` — ${banner.message}` : ''}
          </span>
          {banner.kind === 'auth' ? <button type="button" className="tasks-banner-action" onClick={onOpenSettings}>토큰 다시 붙여넣기</button> : null}
          {banner.kind === 'offline' || banner.kind === 'error' ? <button type="button" className="tasks-banner-action" data-tasks-retry="" onClick={page.retry}>다시 시도</button> : null}
        </div>
      )}

      <WorkLinksContext.Provider value={links}>
      <div className="tasks-body">{body}</div>
      {selectedId === null ? null : (
        <TaskDetail
          work={workActions}
          detail={detail}
          full={prefs.detailFull}
          now={now}
          escapeRef={detailEscape}
          onToggleFull={() => setPrefs({ detailFull: !prefs.detailFull })}
          onClose={() => setSelectedId(null)}
          spaceOf={spaceOf}
        />
      )}
      </WorkLinksContext.Provider>
      </div>
      <QuickCreateModal model={creator} yieldKeys={yieldKeys} />
      {detail.item === null ? null : (
        <StartWorkModal model={starter} itemKey={detail.item.key} itemTitle={detail.item.title} repos={repos} trees={detailTrees} onOpen={onOpenWorktree} />
      )}
    </div>
  )
}

function KeyHits({ hits, selectedId, onSelect }: { hits: { connectionId: string; item: WorkItem; spaceName: string }[]; selectedId: string | null; onSelect: (uid: string) => void }): React.JSX.Element {
  return (
    <div className="tasks-key-hits" data-search-hits="">
      {hits.map((hit) => {
        const uid = itemUid({ connectionId: hit.connectionId, itemId: hit.item.id })
        return (
          <button key={uid} type="button" className={`tasks-key-hit-row${selectedId === uid ? ' is-selected' : ''}`} data-issue-row={hit.item.key} onClick={() => onSelect(uid)}>
            <span className="tasks-key-hit" data-search-hit="">키 일치</span>
            <span className="tasks-row-key">{hit.item.key}</span>
            <span className="tasks-row-title">{hit.item.title}</span>
            <span className="tasks-row-space">{hit.spaceName}</span>
          </button>
        )
      })}
    </div>
  )
}

function FilterMenu({ id, label, open, onToggle, options, selected, onPick }: {
  id: 'kind' | 'priority'
  label: string
  open: boolean
  onToggle: () => void
  options: { key: string; label: string }[]
  selected: string[]
  onPick: (key: string) => void
}): React.JSX.Element {
  const on = selected.length > 0
  const names = options.filter((option) => selected.includes(option.key)).map((option) => option.label)
  return (
    <div className="tasks-filter-anchor">
      <button type="button" className={`tasks-filter${on ? ' is-on' : ''}`} data-filter={id} aria-pressed={on} aria-expanded={open} onClick={onToggle}>
        {label}{on ? ` · ${names.join(', ')}` : ''} <span className="tasks-caret" aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="tasks-menu tasks-filter-menu" data-tasks-menu={id} role="menu">
          {options.length === 0 ? <div className="tasks-menu-note">선택지가 없습니다</div> : null}
          {options.map((option) => (
            <button key={option.key} type="button" className={`tasks-menu-row${selected.includes(option.key) ? ' is-on' : ''}`} role="menuitemcheckbox" aria-checked={selected.includes(option.key)} onClick={() => onPick(option.key)}>
              <span className="tasks-check" aria-hidden>{selected.includes(option.key) ? '✓' : ''}</span>
              <span className="tasks-menu-name">{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 같은 영역 안에서 제자리에 놓았나 — 순서 요청을 보내지 않는다. */
function unchangedPosition({ row, laneRows, index }: { row: TasksRow; laneRows: TasksRow[]; index: number }): boolean {
  const at = laneRows.findIndex((entry) => rowUid(entry) === rowUid(row))
  return at === index
}
