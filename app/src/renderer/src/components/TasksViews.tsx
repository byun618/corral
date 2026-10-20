// 작업 페이지 보기 4 (LIFE-601) — 보드 · 백로그 · 리스트 · 작업 중. 계산은 `tasks-model.ts`, 자료·쓰기는 `useTasksPage`, 끌기는 `useTaskDrag`.
// 출처 이름으로 분기하지 않는다 — 능력 표(흐림 + 이유 / 숨김)와 상태 목록만 본다(K3).
import { Fragment, useState } from 'react'
import type { WorkCapabilities, WorkCategory, WorkItem, WorkStatus } from '../../../shared/work.js'
import { elapsedLabel } from '../../../shared/session-activity.js'
import { AGENT_DOT_LABEL } from '../agent-dot.js'
import type { TaskDragState } from '../hooks/useTaskDrag.js'
import type { WorkingLookup } from '../hooks/useTasksPage.js'
import {
  PRIORITY_GLYPH,
  PRIORITY_LABEL,
  TASKS_PRESET_LABEL,
  TASKS_PRESETS,
  TASKS_GROUPS,
  TASKS_SORT_LABEL,
  TASKS_SORTS,
  blockedLabel,
  childProgress,
  dueLabel,
  dueTone,
  itemUid,
  rowUid,
  type BoardBand,
  type BoardColumn,
  type ListGroup,
  type TasksDensity,
  type TasksGroup,
  type TasksPreset,
  type TasksRow,
  type TasksSort,
  type WorkingEntry,
  type WorkingTree,
} from '../tasks-model.js'
import { AgentStateDot } from './AgentStateDot.js'
import { WorktreeChip, WorktreeDotMark } from './WorkLinkChips.js'

const IDLE_VIEW: ColumnDragView = { mode: 'idle', reason: null }

// --- 작은 조각 ---

/** 작업 상태 원 — 분류 색, 진행 중은 워크플로 위치만큼 채움(핸드오프 Q4). */
export function StatusCircle({ category, fill, size = 10 }: { category: WorkCategory; fill: number; size?: number }): React.JSX.Element {
  const r = size / 2 - 1
  const c = size / 2
  return (
    <svg className={`tasks-status-circle cat-${category}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="1.5" />
      {category === 'done' ? <circle cx={c} cy={c} r={r - 1.5} fill="currentColor" /> : null}
      {category === 'in_progress' ? <path d={describeArc({ c, r: r - 1.5, ratio: fill })} fill="currentColor" /> : null}
    </svg>
  )
}

function describeArc({ c, r, ratio }: { c: number; r: number; ratio: number }): string {
  const clamped = Math.min(0.999, Math.max(0.05, ratio))
  const angle = clamped * 2 * Math.PI
  const x = c + r * Math.sin(angle)
  const y = c - r * Math.cos(angle)
  return `M ${c} ${c} L ${c} ${c - r} A ${r} ${r} 0 ${clamped > 0.5 ? 1 : 0} 1 ${x} ${y} Z`
}

/** 종류 모양 아이콘 — 종류 키의 해시로 모양 하나(출처 이름이 아니라 종류 키만 본다). Checkpoint·Epic 류는 다이아몬드. */
export function KindIcon({ kind }: { kind: { key: string; label: string } }): React.JSX.Element {
  const shape = kindShape(kind.key)
  return (
    <svg className={`tasks-kind kind-${shape}`} width="12" height="12" viewBox="0 0 12 12" aria-label={kind.label} role="img">
      <title>{kind.label}</title>
      {shape === 'diamond' ? <path d="M6 1 L11 6 L6 11 L1 6 Z" fill="none" stroke="currentColor" strokeWidth="1.4" /> : null}
      {shape === 'bug' ? <circle cx="6" cy="6" r="4" fill="currentColor" /> : null}
      {shape === 'square' ? <rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" /> : null}
    </svg>
  )
}

function kindShape(key: string): 'diamond' | 'bug' | 'square' {
  const lower = key.toLowerCase()
  if (lower === 'bug') return 'bug'
  if (lower === 'checkpoint' || lower === 'epic' || lower === 'project') return 'diamond'
  return 'square'
}

export function SpaceDot({ color, index }: { color: string | null; index: number }): React.JSX.Element {
  return <span className="tasks-space-dot" style={{ background: color ?? `var(--space-${index})` }} aria-hidden />
}

function PriorityMark({ item }: { item: WorkItem }): React.JSX.Element | null {
  if (item.priority === null) return null
  const glyph = PRIORITY_GLYPH[item.priority]
  return glyph === null ? null : <span className={`tasks-prio prio-${item.priority}`} title={PRIORITY_LABEL[item.priority]}>{glyph}</span>
}

function DueMark({ item, now }: { item: WorkItem; now: number }): React.JSX.Element | null {
  const tone = dueTone({ dueAt: item.dueAt, now })
  const label = dueLabel(item.dueAt)
  return tone === null || label === null ? null : <span className={`tasks-due due-${tone}`} title={`마감 ${label}`}>{label}</span>
}

function BlockedBadge({ item }: { item: WorkItem }): React.JSX.Element | null {
  const label = blockedLabel(item)
  if (label === null) return null
  return (
    <span className="tasks-blocked" data-issue-blocked="" title={item.openBlockers.map((blocker) => `${blocker.key} ${blocker.title}`).join('\n')}>
      <span className="tasks-blocked-dot" aria-hidden />
      {label}
    </span>
  )
}

// --- 카드 (C6) ---

export type CardProps = {
  row: TasksRow
  rows: TasksRow[]
  all: boolean
  density: TasksDensity
  selected: boolean
  dragging: boolean
  now: number
  handle: { blocked: string | null; onMouseDown: (event: React.MouseEvent<HTMLElement>) => void } | null
  onSelect: () => void
}

export function IssueCard({ row, rows, all, density, selected, dragging, now, handle, onSelect }: CardProps): React.JSX.Element {
  const { item } = row
  const [expanded, setExpanded] = useState(false)
  const progress = childProgress({ row, rows })
  const uid = rowUid(row)
  const className = `tasks-card${density === 'compact' ? ' is-compact' : ''}${selected ? ' is-selected' : ''}${dragging ? ' is-drag-source' : ''}${handle?.blocked ? ' is-locked' : ''}`
  const common = {
    className,
    'data-issue-card': item.key,
    'data-drag-item': uid,
    'aria-selected': selected,
    title: handle?.blocked ?? undefined,
    onMouseDown: handle?.onMouseDown,
    onClick: onSelect,
  }
  if (density === 'compact') {
    return (
      <div {...common}>
        <div className="tasks-card-line">
          <KindIcon kind={item.kind} />
          <span className="tasks-key">{item.key}</span>
          <span className="tasks-card-title-one">{item.title}</span>
          <PriorityMark item={item} />
          {item.openBlockerCount > 0 ? <span className="tasks-blocked-dot" data-issue-blocked="" title={blockedLabel(item) ?? ''} /> : null}
          <WorktreeDotMark connectionId={row.space.connectionId} item={item} />
        </div>
      </div>
    )
  }
  return (
    <div {...common}>
      <div className="tasks-card-line">
        <KindIcon kind={item.kind} />
        <span className="tasks-key">{item.key}</span>
        {all ? <span className="tasks-card-space"><SpaceDot color={row.space.color} index={row.space.colorIndex} />{row.space.spaceName}</span> : null}
        <span className="tasks-card-spacer" />
        <PriorityMark item={item} />
        <DueMark item={item} now={now} />
      </div>
      <div className="tasks-card-title">{item.title}</div>
      {all ? <div className="tasks-card-status"><StatusCircle category={item.category} fill={0.5} size={8} />{row.status?.label ?? '보드에 칸이 없는 상태'}</div> : null}
      <BlockedBadge item={item} />
      <WorktreeChip connectionId={row.space.connectionId} item={item} />
      {progress === null ? null : (
        <div className="tasks-progress" data-issue-progress="" data-progress-partial={progress.partial ? '' : undefined}>
          <button type="button" className="tasks-progress-toggle" data-no-drag="" title={progress.partial ? '이 스페이스의 작업을 아직 다 받지 않았습니다 — 받은 자식만 셉니다' : undefined} onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value) }} aria-expanded={expanded}>
            {expanded ? '▾' : '▸'} 자식 {progress.done}/{progress.total}{progress.partial ? ' · 받은 것' : ''}
          </button>
          <div className="tasks-progress-bar"><span style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
          {expanded ? (
            <div className="tasks-children">
              {progress.children.map((child) => (
                <div key={rowUid(child)} className="tasks-child-row">
                  <StatusCircle category={child.item.category} fill={0.5} size={8} />
                  <span className="tasks-key">{child.item.key}</span>
                  <span className="tasks-child-title">{child.item.title}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

// --- 보드 ---

export type ColumnDragView = { mode: 'target' | 'source' | 'blocked' | 'idle'; reason: string | null }

export function Board({ bands, rows, all, density, selectedId, drag, now, columnView, handleOf, onSelect, columnFooter }: {
  bands: BoardBand[]
  rows: TasksRow[]
  all: boolean
  density: TasksDensity
  selectedId: string | null
  drag: TaskDragState | null
  now: number
  columnView: (column: BoardColumn) => ColumnDragView
  handleOf: (row: TasksRow) => CardProps['handle']
  onSelect: (row: TasksRow) => void
  /** 칸 끝 「+ 추가」(LIFE-604 C7) — 그리지 않으면 null. */
  columnFooter?: (column: BoardColumn) => React.ReactNode
}): React.JSX.Element {
  return (
    <div className="tasks-board" data-tasks-board="">
      {bands.map((band) => (
        <section key={band.id} className={`tasks-band cat-${band.category}${band.id === 'unmapped' ? ' is-unmapped' : ''}`} data-board-band={band.id}>
          <header className="tasks-band-head"><span className="tasks-band-label">{band.label}</span><span className="tasks-band-count">{band.count}</span></header>
          <div className="tasks-band-columns">
            {band.columns.map((column) => {
              const view = drag === null ? IDLE_VIEW : columnView(column)
              const zone = `col:${column.id}`
              const showGap = drag !== null && drag.zone === zone && view.mode === 'target'
              const visible = column.rows
              return (
                <div key={column.id} className={`tasks-column${column.unmapped ? ' is-unmapped' : ''} drag-${view.mode}${drag?.zone === zone ? ' is-over' : ''}`} data-board-column={column.id}>
                  <header className="tasks-column-head">
                    {column.unmapped ? <span className="tasks-unmapped-mark" aria-hidden>⋯</span> : <StatusCircle category={column.category} fill={column.fill} />}
                    <span className="tasks-column-label">{column.label}</span>
                    <span className="tasks-column-count">{column.rows.length}</span>
                  </header>
                  {column.unmapped ? <div className="tasks-column-note">출처 워크플로에 칸이 없는 상태입니다 — 여기로 옮길 수는 없습니다.</div> : null}
                  {view.reason !== null ? <div className="tasks-column-reason" data-column-reason="">{view.reason}</div> : null}
                  <div className="tasks-column-list" data-drop-zone={zone}>
                    {withGap({ rows: visible, drag, showGap }).map((entry) => (entry.kind === 'gap'
                      ? <div key="gap" className="tasks-drop-gap" style={{ height: entry.height }} data-drop-gap="" />
                      : (
                          <IssueCard
                            key={rowUid(entry.row)}
                            row={entry.row}
                            rows={rows}
                            all={all}
                            density={density}
                            selected={selectedId === rowUid(entry.row)}
                            dragging={drag?.itemId === rowUid(entry.row)}
                            now={now}
                            handle={handleOf(entry.row)}
                            onSelect={() => onSelect(entry.row)}
                          />
                        )))}
                    {columnFooter?.(column) ?? null}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

/** 끄는 중이면 놓일 번호(끄는 항목을 뺀 순서 기준)에 틈을 끼운다 — 다른 카드가 밀린다. */
function withGap({ rows, drag, showGap }: { rows: TasksRow[]; drag: TaskDragState | null; showGap: boolean }): ({ kind: 'row'; row: TasksRow } | { kind: 'gap'; height: number })[] {
  const entries: ({ kind: 'row'; row: TasksRow } | { kind: 'gap'; height: number })[] = []
  let position = 0
  for (const row of rows) {
    const isSource = drag?.itemId === rowUid(row)
    if (showGap && drag !== null && !isSource && position === drag.index) entries.push({ kind: 'gap', height: drag.height })
    entries.push({ kind: 'row', row })
    if (!isSource) position += 1
  }
  if (showGap && drag !== null && position <= drag.index) entries.push({ kind: 'gap', height: drag.height })
  return entries
}

// --- 백로그 (C8) ---

export function Backlog({ sections, all, selectedId, drag, now, sectionView, handleOf, onSelect, sectionAdd }: {
  sections: { id: 'board' | 'backlog'; label: string; rows: TasksRow[] }[]
  all: boolean
  selectedId: string | null
  drag: TaskDragState | null
  now: number
  sectionView: (id: 'board' | 'backlog') => ColumnDragView
  handleOf: (row: TasksRow) => CardProps['handle']
  onSelect: (row: TasksRow) => void
  /** 섹션 머리 「추가」(LIFE-604) — 그 섹션 배치로 빠른 생성을 연다. 그리지 않으면 null. */
  sectionAdd?: (id: 'board' | 'backlog') => React.ReactNode
}): React.JSX.Element {
  return (
    <div className="tasks-backlog" data-tasks-backlog="">
      {sections.map((section) => {
        const view = drag === null ? IDLE_VIEW : sectionView(section.id)
        const zone = `sec:${section.id}`
        const showGap = drag !== null && drag.zone === zone && view.mode === 'target'
        return (
          <section key={section.id} className={`tasks-backlog-section drag-${view.mode}${drag?.zone === zone ? ' is-over' : ''}`} data-backlog-section={section.id}>
            <header className="tasks-backlog-head"><span className="tasks-backlog-title"><span>{section.label}</span><span className="tasks-column-count">{section.rows.length}</span></span>{sectionAdd?.(section.id) ?? null}</header>
            {view.reason !== null ? <div className="tasks-column-reason" data-column-reason="">{view.reason}</div> : null}
            <div className="tasks-backlog-list" data-drop-zone={zone}>
              {section.rows.length === 0 && !showGap ? <div className="tasks-backlog-empty">비어 있음</div> : null}
              {withGap({ rows: section.rows, drag, showGap }).map((entry) => (entry.kind === 'gap'
                ? <div key="gap" className="tasks-drop-gap is-row" style={{ height: entry.height }} data-drop-gap="" />
                : <IssueRow key={rowUid(entry.row)} row={entry.row} all={all} now={now} selected={selectedId === rowUid(entry.row)} dragging={drag?.itemId === rowUid(entry.row)} handle={handleOf(entry.row)} onSelect={() => onSelect(entry.row)} keyHit={false} />))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

// --- 행 (리스트·백로그) ---

export function IssueRow({ row, all, now, selected, dragging, handle, onSelect, keyHit, spaceName }: {
  row: TasksRow | { item: WorkItem; space: null; status: WorkStatus | null }
  all: boolean
  now: number
  selected: boolean
  dragging: boolean
  handle: CardProps['handle']
  onSelect: () => void
  keyHit: boolean
  spaceName?: string
}): React.JSX.Element {
  const { item } = row
  const className = `tasks-row${selected ? ' is-selected' : ''}${dragging ? ' is-drag-source' : ''}${keyHit ? ' is-key-hit' : ''}`
  return (
    <div className={className} data-issue-row={item.key} data-drag-item={handle === null || row.space === null ? undefined : itemUid({ connectionId: row.space.connectionId, itemId: item.id })} aria-selected={selected} onClick={onSelect}>
      {handle === null ? null : (
        <span className={`tasks-grip${handle.blocked ? ' is-locked' : ''}`} title={handle.blocked ?? '끌어서 옮기기'} onMouseDown={handle.onMouseDown} aria-hidden>⋮⋮</span>
      )}
      <StatusCircle category={item.category} fill={0.5} />
      <KindIcon kind={item.kind} />
      <span className="tasks-row-key">{item.key}</span>
      {keyHit ? <span className="tasks-key-hit" data-search-hit="">키 일치</span> : null}
      <span className="tasks-row-title">{item.title}</span>
      <BlockedBadge item={item} />
      <WorktreeChip connectionId={row.space?.connectionId ?? null} item={item} />
      {all || spaceName !== undefined ? (
        <span className="tasks-row-space">
          {row.space !== null ? <SpaceDot color={row.space.color} index={row.space.colorIndex} /> : null}
          {spaceName ?? row.space?.spaceName ?? ''}
        </span>
      ) : null}
      <span className="tasks-row-status">{row.status?.label ?? (row.space === null ? '' : '보드에 칸이 없는 상태')}</span>
      <span className="tasks-row-prio"><PriorityMark item={item} /></span>
      <span className="tasks-row-due"><DueMark item={item} now={now} /></span>
    </div>
  )
}

// --- 리스트 (C9) ---

export function ListView({ groups, all, now, selectedId, sort, group, preset, defaultPreset, groupLabel, hits, more, onSort, onGroup, onPreset, onDefaultPreset, onSelect, onLoadMore }: {
  groups: ListGroup[]
  all: boolean
  now: number
  selectedId: string | null
  sort: TasksSort
  group: TasksGroup
  preset: TasksPreset | null
  defaultPreset: TasksPreset
  groupLabel: (group: TasksGroup) => string
  hits: { connectionId: string; item: WorkItem; spaceName: string }[]
  more: MoreState
  onSort: (sort: TasksSort) => void
  onGroup: (group: TasksGroup) => void
  onPreset: (preset: TasksPreset) => void
  onDefaultPreset: (preset: TasksPreset) => void
  onSelect: (uid: string) => void
  onLoadMore: () => void
}): React.JSX.Element {
  // 다음 커서가 있거나 상한에서 잘렸으면 그룹 수는 받은 것만의 집계다(R3-J).
  const hasMore = more?.kind === 'cursor' || more?.kind === 'capped'
  return (
    <div className="tasks-list" data-tasks-list="">
      <div className="tasks-list-tools" data-tasks-list-tools="">
        <label className="tasks-select">정렬
          <select value={sort} onChange={(event) => onSort(TASKS_SORTS.find((entry) => entry === event.target.value) ?? 'rank')} data-tasks-sort="">
            {TASKS_SORTS.map((entry) => <option key={entry} value={entry}>{TASKS_SORT_LABEL[entry]}</option>)}
          </select>
        </label>
        <label className="tasks-select">그룹
          <select value={group} onChange={(event) => onGroup(event.target.value === 'priority' ? 'priority' : event.target.value === 'none' ? 'none' : 'status')} data-tasks-group="">
            {TASKS_GROUPS.map((entry) => <option key={entry} value={entry}>{groupLabel(entry)}</option>)}
          </select>
        </label>
        <span className="tasks-list-sep" aria-hidden />
        <span className="tasks-list-presets-label">프리셋</span>
        {TASKS_PRESETS.map((entry) => (
          <button
            key={entry}
            type="button"
            className={`tasks-preset${preset === entry ? ' is-on' : ''}`}
            data-tasks-preset={entry}
            title="우클릭 = 기본 프리셋으로"
            onClick={() => onPreset(entry)}
            onContextMenu={(event) => { event.preventDefault(); onDefaultPreset(entry) }}
          >
            {defaultPreset === entry ? <span className="tasks-preset-default" data-preset-default="" aria-label="기본" /> : null}
            {TASKS_PRESET_LABEL[entry]}
          </button>
        ))}
      </div>
      <div className="tasks-list-scroll" data-tasks-scroll="list">
        {/* 안쪽 래퍼 하나 — 행이 보기보다 넓으면 묶음 머리·행·푸터가 같은 폭(가장 넓은 행)으로 스크롤 폭을 채운다(LIFE-670 r3 L-F). */}
        <div className="tasks-list-inner">
        {hits.map((hit) => {
          const uid = itemUid({ connectionId: hit.connectionId, itemId: hit.item.id })
          return <IssueRow key={`hit-${uid}`} row={{ item: hit.item, space: null, status: null }} all={all} now={now} selected={selectedId === uid} dragging={false} handle={null} onSelect={() => onSelect(uid)} keyHit spaceName={hit.spaceName} />
        })}
        {groups.map((entry) => (
          <Fragment key={entry.id}>
            <div className="tasks-list-group" data-list-group={entry.id} title={hasMore ? '받아 둔 행 기준 — 더 있을 수 있습니다' : undefined}>
              <span className="tasks-list-group-title"><span>{entry.label}</span><span className="tasks-column-count">{entry.rows.length}{hasMore ? ' / 받은 것' : ''}</span></span>
            </div>
            {entry.rows.map((row) => (
              <IssueRow key={rowUid(row)} row={row} all={all} now={now} selected={selectedId === rowUid(row)} dragging={false} handle={null} onSelect={() => onSelect(rowUid(row))} keyHit={false} />
            ))}
          </Fragment>
        ))}
        <MoreBar more={more} onLoadMore={onLoadMore} />
        </div>
      </div>
    </div>
  )
}

// --- 더 불러오기 (C9) — 리스트·보드·백로그 공통. 커서가 있으면 다음 쪽, 커서가 꺼진 출처가 상한에 닿았으면 「최대 N건」 + 흐림 + 이유. ---

export type MoreState = { kind: 'cursor'; loaded: number; loading: boolean } | { kind: 'capped'; loaded: number; reason: string | null } | null

export function MoreBar({ more, onLoadMore }: { more: MoreState; onLoadMore: () => void }): React.JSX.Element | null {
  if (more === null) return null
  if (more.kind === 'cursor') {
    return (
      <div className="tasks-list-more" data-tasks-more="">
        <span>{more.loaded} / 전체 — 더 있습니다</span>
        <button type="button" className="tasks-more-btn" data-tasks-more-button="" onClick={onLoadMore} disabled={more.loading}>{more.loading ? '불러오는 중…' : '더 불러오기'}</button>
      </div>
    )
  }
  return (
    <div className="tasks-list-more is-capped" data-tasks-more="capped" title={more.reason ?? undefined}>
      <span>최대 {more.loaded}건까지만 받았습니다</span>
      <button type="button" className="tasks-more-btn" disabled title={more.reason ?? undefined}>더 불러오기</button>
      {more.reason !== null ? <span className="tasks-more-reason">{more.reason}</span> : null}
    </div>
  )
}

// --- 작업 중 (C11) ---

export type WorkingView = { entry: WorkingEntry; lookup: WorkingLookup }

export function WorkingList({ views, now, onOpen }: { views: WorkingView[]; now: number; onOpen: (tree: WorkingTree) => void }): React.JSX.Element {
  return (
    <div className="tasks-working" data-tasks-working="">
      {views.map(({ entry, lookup }) => (
        <section key={`${entry.connectionId}::${entry.key}`} className="tasks-working-item" data-working-item={entry.key}>
          <header className="tasks-working-head">
            {lookup.state === 'found' ? (
              <>
                <StatusCircle category={lookup.item.category} fill={0.5} />
                <KindIcon kind={lookup.item.kind} />
                <span className="tasks-row-key">{lookup.item.key}</span>
                <span className="tasks-row-title">{lookup.item.title}</span>
                <span className="tasks-row-space">{lookup.spaceName}</span>
              </>
            ) : (
              <>
                <span className="tasks-row-key">{entry.key}</span>
                <span className="tasks-row-title is-missing" data-working-missing={lookup.state}>
                  {lookup.state === 'loading' ? '작업을 찾는 중…' : lookup.state === 'missing' ? '작업을 찾지 못함 — 출처에 이 키가 없습니다' : `작업을 찾지 못함 — ${lookup.message}`}
                </span>
              </>
            )}
          </header>
          {entry.trees.map((tree) => (
            <button key={tree.path} type="button" className="tasks-working-tree" data-working-worktree={tree.branch} onClick={() => onOpen(tree)} title={tree.path}>
              <span className="tasks-working-dot">{tree.dot === null ? null : <AgentStateDot dot={tree.dot} />}</span>
              <span className="tasks-working-state">{tree.dot === null ? '에이전트 없음' : AGENT_DOT_LABEL[tree.dot]}</span>
              <span className="tasks-working-branch"><span className="tasks-working-repo">{tree.repoName}</span> / {tree.branch}</span>
              {/* 시간 = 그 worktree 세션의 마지막 활동(세션 지문). 없으면 그리지 않는다 — 지어낸 시각을 쓰지 않는다(R1-R). */}
              {elapsedLabel(tree.activityAt, now) === null ? null : <span className="tasks-working-time" data-working-time="">{elapsedLabel(tree.activityAt, now)}</span>}
              <span className="tasks-working-chevron" aria-hidden>›</span>
            </button>
          ))}
        </section>
      ))}
    </div>
  )
}

/** 출처 능력 → 끌기 방향별 막힘 이유. `hidden` 이면 null 이 아니라 'hidden'(손잡이·표시 없음). */
export function capabilityGate(capabilities: WorkCapabilities | null, name: 'order' | 'placement'): { state: 'on' } | { state: 'hidden' } | { state: 'disabled'; reason: string } {
  if (capabilities === null) return { state: 'on' }
  return capabilities[name]
}
