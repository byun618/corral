// 소스 제어 보기 (LIFE-683 S2~S4·S9) — 오른쪽 패널 몸통. 읽기 전용: 변경 목록 + 클릭 = diff 탭. stage·commit 등 쓰기 입력은 그리지 않는다(S7).
//
// · 모양은 VS Code SCM 보기(`scmViewPane.ts`) — 그룹 머리(twistie · 제목 · 오른쪽 개수), 22px 행(파일 아이콘 · 이름 · 흐린 부모 경로 · 오른쪽 상태 글자).
//   글자·색은 탐색기 배지와 같은 표(`GIT_DECORATION`), 이름은 기본 글자색(VS Code `fileDecorations.colors: false`), 삭제는 취소선.
// · 목록 / 트리(폴더 압축) 전환은 머리 단추 — 선택은 ui-prefs `scmViewMode` 에 영속(Q6). 접기 상태는 메모리(VS Code 와 같다 — 세션 동안).
// · 행이 많을 수 있어(상한 10 000 — `git.statusLimit`) 22px 고정 높이로 보이는 칸만 그린다.
// · 키보드는 탐색기와 같은 관례: ↑↓ Home End 이동 · ← 접기/부모 · → 펼치기 · Enter 열기(고정) · Space 열기(미리보기).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GIT_DECORATION } from '../../../shared/explorer-git.js'
import { buildTree, flattenTree, groupChanges, SCM_STATUS_LIMIT, scmErrorKind, SCM_STATUS_TEXT, scmMark, scmStrike, type ScmChange, type ScmGroupId } from '../../../shared/scm.js'
import type { ScmApi } from '../hooks/useScm.js'
import { Codicon, FileIcon } from './ExplorerIcons.js'
import './scm.css'

const ROW_HEIGHT = 22
const OVERSCAN = 10

export type ScmViewMode = 'list' | 'tree'

export type ScmRow =
  | { kind: 'group'; key: string; group: ScmGroupId; title: string; count: number; collapsed: boolean }
  | { kind: 'dir'; key: string; group: ScmGroupId; name: string; path: string; depth: number; collapsed: boolean }
  | { kind: 'file'; key: string; group: ScmGroupId; change: ScmChange; name: string; parent: string; depth: number }

const nameOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)
const parentOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')

/** 그릴 줄 — 그룹 머리 + (목록: 경로순 파일 · 트리: 폴더 먼저 압축 트리). 접힌 그룹·폴더의 자식은 뺀다. 순수 함수(시험 대상). */
export function scmRows(input: { changes: readonly ScmChange[]; mode: ScmViewMode; collapsed: ReadonlySet<string>; limit?: number; total?: number }): { rows: ScmRow[]; total: number; truncated: boolean } {
  const grouped = groupChanges(input.changes, input.limit ?? SCM_STATUS_LIMIT, input.total ?? input.changes.length)
  const rows: ScmRow[] = []
  for (const group of grouped.groups) {
    const groupKey = `g:${group.id}`
    const groupCollapsed = input.collapsed.has(groupKey)
    rows.push({ kind: 'group', key: groupKey, group: group.id, title: group.title, count: group.changes.length, collapsed: groupCollapsed })
    if (groupCollapsed) continue
    if (input.mode === 'list') {
      for (const change of group.changes) rows.push({ kind: 'file', key: `f:${group.id}:${change.rel}`, group: group.id, change, name: nameOf(change.rel), parent: parentOf(change.rel), depth: 1 })
      continue
    }
    const dirCollapsed = new Set([...input.collapsed].filter((key) => key.startsWith(`d:${group.id}:`)).map((key) => key.slice(`d:${group.id}:`.length)))
    for (const row of flattenTree(buildTree(group.changes), dirCollapsed)) {
      if (row.kind === 'dir') rows.push({ kind: 'dir', key: `d:${group.id}:${row.path}`, group: group.id, name: row.name, path: row.path, depth: row.depth, collapsed: row.collapsed })
      else rows.push({ kind: 'file', key: `f:${group.id}:${row.change.rel}`, group: group.id, change: row.change, name: row.name, parent: '', depth: row.depth })
    }
  }
  return { rows, total: grouped.total, truncated: grouped.truncated }
}

/** 행 툴팁 — 경로 • 상태 문구, 이름 바뀜은 원래 경로(VS Code `getStatusText` + 원래 경로). */
export function scmRowTitle(change: ScmChange): string {
  const status = SCM_STATUS_TEXT[change.status]
  return change.orig === null ? `${change.rel} • ${status}` : `${change.rel} • ${status} (원래 ${change.orig})`
}

export function ScmView({
  scm,
  title,
  mode,
  onChangeMode,
  focusToken,
  onOpen,
}: {
  scm: ScmApi
  /** 활성 worktree 이름(머리 툴팁) — 없으면 null. */
  title: string | null
  mode: ScmViewMode
  onChangeMode: (mode: ScmViewMode) => void
  /** ⌘⇧G — 바뀌면 목록에 포커스. */
  focusToken: number
  onOpen: (input: { change: ScmChange; preview: boolean }) => void
}): React.JSX.Element {
  const [collapsedByRoot, setCollapsedByRoot] = useState(() => new Map<string, Set<string>>())
  const [selectedByRoot, setSelectedByRoot] = useState(() => new Map<string, string>())
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(400)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const root = scm.root
  const changes = scm.state?.changes ?? null
  const collapsed = useMemo(() => (root === null ? new Set<string>() : (collapsedByRoot.get(root) ?? new Set<string>())), [collapsedByRoot, root])
  const selected = root === null ? null : (selectedByRoot.get(root) ?? null)
  const changesTotal = scm.state?.total ?? 0
  const { rows, total, truncated } = useMemo(() => (changes === null ? { rows: [], total: 0, truncated: false } : scmRows({ changes, mode, collapsed, total: changesTotal })), [changes, mode, collapsed, changesTotal])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const observer = new ResizeObserver(() => setHeight(element.clientHeight))
    observer.observe(element)
    setHeight(element.clientHeight)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (focusToken === 0) return
    listRef.current?.focus({ preventScroll: true })
  }, [focusToken])

  const setCollapsed = useCallback(
    (update: (current: Set<string>) => Set<string>) => {
      if (root === null) return
      setCollapsedByRoot((current) => new Map(current).set(root, update(new Set(current.get(root) ?? []))))
    },
    [root],
  )
  const select = useCallback(
    (key: string) => {
      if (root === null) return
      setSelectedByRoot((current) => new Map(current).set(root, key))
    },
    [root],
  )
  const toggleKey = (key: string): void =>
    setCollapsed((current) => {
      if (current.has(key)) current.delete(key)
      else current.add(key)
      return current
    })
  const collapseAll = (): void => setCollapsed(() => new Set(rows.filter((row) => row.kind === 'dir' || row.kind === 'group').map((row) => row.key)))

  const ensureVisible = (index: number): void => {
    const element = scrollRef.current
    if (element === null) return
    const top = index * ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW_HEIGHT - element.clientHeight
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (rows.length === 0) return
    const index = Math.max(0, rows.findIndex((row) => row.key === selected))
    const row = rows[index]
    const move = (to: number): void => {
      const clamped = Math.max(0, Math.min(rows.length - 1, to))
      const target = rows[clamped]
      if (target === undefined) return
      select(target.key)
      ensureVisible(clamped)
    }
    switch (event.key) {
      case 'ArrowDown':
        move(selected === null ? 0 : index + 1)
        break
      case 'ArrowUp':
        move(selected === null ? 0 : index - 1)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(rows.length - 1)
        break
      case 'ArrowLeft':
        if (row === undefined) return
        if (row.kind !== 'file' && !row.collapsed) toggleKey(row.key)
        else {
          // 부모(폴더 또는 그룹 머리)로.
          const depth = row.kind === 'group' ? 0 : row.depth
          for (let at = index - 1; at >= 0; at -= 1) {
            const candidate = rows[at]
            if (candidate !== undefined && candidate.kind !== 'file' && (candidate.kind === 'group' ? 0 : candidate.depth) < depth) {
              move(at)
              break
            }
          }
        }
        break
      case 'ArrowRight':
        if (row !== undefined && row.kind !== 'file' && row.collapsed) toggleKey(row.key)
        else move(index + 1)
        break
      case 'Enter':
      case ' ':
        if (row === undefined) return
        if (row.kind === 'file') onOpen({ change: row.change, preview: event.key === ' ' })
        else toggleKey(row.key)
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)
  const notice =
    root === null
      ? '열린 worktree 가 없습니다.'
      : scm.state === null
        ? null
        : scm.state.error !== null
          ? // fix r1 R1-08 — 저장소 아님만 VS Code 문구(`package.nls.json:407-408`), 타임아웃·출력 상한·git 없음은 조회 실패.
            scmErrorKind(scm.state.error) === 'not_repo'
            ? '현재 열린 폴더에 Git 리포지토리가 없습니다.'
            : `Git 상태를 읽지 못했습니다 — ${scm.state.error.split('\n').find((line) => line.trim() !== '' && !line.startsWith('Command failed')) ?? scm.state.error}`
          : changes !== null && changes.length === 0
            ? '변경 사항 없음'
            : null

  return (
    <div className="scm" data-scm="" data-scm-mode={mode}>
      <div className="explorer-section-head" data-scm-head="">
        <span className="explorer-section-twistie" />
        <span className="explorer-section-title" title={title ?? undefined}>
          소스 제어
        </span>
        <div className="explorer-toolbar">
          <button
            type="button"
            className="explorer-tool"
            data-scm-view-mode={mode === 'list' ? 'tree' : 'list'}
            title={mode === 'list' ? '트리로 보기' : '목록으로 보기'}
            aria-label={mode === 'list' ? '트리로 보기' : '목록으로 보기'}
            onClick={() => onChangeMode(mode === 'list' ? 'tree' : 'list')}
          >
            <Codicon name={mode === 'list' ? 'list-tree' : 'list-flat'} />
          </button>
          <button type="button" className="explorer-tool" data-scm-refresh="" title="새로고침" aria-label="새로고침" disabled={root === null} onClick={scm.refresh}>
            <Codicon name="refresh" />
          </button>
          <button type="button" className="explorer-tool" data-scm-collapse-all="" title="모두 접기" aria-label="모두 접기" disabled={rows.length === 0} onClick={collapseAll}>
            <Codicon name="collapse-all" />
          </button>
        </div>
      </div>
      {truncated ? (
        <div className="scm-banner" data-scm-truncated="">
          변경이 너무 많아 처음 {SCM_STATUS_LIMIT.toLocaleString()}개만 표시합니다(전체 {total.toLocaleString()}개).
        </div>
      ) : null}
      <div className="explorer-scroll" ref={scrollRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        {notice !== null ? (
          <div className="explorer-empty" data-scm-empty="">
            {notice}
          </div>
        ) : (
          <div
            className="explorer-tree scm-list"
            ref={listRef}
            role="tree"
            aria-label="소스 제어 변경"
            tabIndex={0}
            data-scm-list=""
            style={{ height: rows.length * ROW_HEIGHT }}
            onKeyDown={onKeyDown}
          >
            {rows.slice(first, last).map((row, offset) => (
              <ScmRowView
                key={row.key}
                row={row}
                top={(first + offset) * ROW_HEIGHT}
                selected={row.key === selected}
                onClick={() => {
                  select(row.key)
                  if (row.kind === 'file') onOpen({ change: row.change, preview: true })
                  else toggleKey(row.key)
                }}
                onDoubleClick={() => {
                  if (row.kind === 'file') onOpen({ change: row.change, preview: false })
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ScmRowView({ row, top, selected, onClick, onDoubleClick }: { row: ScmRow; top: number; selected: boolean; onClick: () => void; onDoubleClick: () => void }): React.JSX.Element {
  if (row.kind === 'group')
    return (
      <div className={`explorer-row scm-group${selected ? ' is-selected' : ''}`} role="treeitem" aria-level={1} aria-expanded={!row.collapsed} aria-selected={selected} data-scm-group={row.group} style={{ top }} onClick={onClick}>
        <span className={`explorer-twistie is-collapsible${row.collapsed ? ' is-collapsed' : ''}`} style={{ paddingLeft: 0 }}>
          <Codicon name="chevron-down" />
        </span>
        <span className="explorer-label scm-group-title">{row.title}</span>
        <span className="scm-count" data-scm-count={row.count}>
          {row.count}
        </span>
      </div>
    )
  const indent = row.depth * 8
  if (row.kind === 'dir')
    return (
      <div className={`explorer-row${selected ? ' is-selected' : ''}`} role="treeitem" aria-level={row.depth + 1} aria-expanded={!row.collapsed} aria-selected={selected} data-scm-dir={row.path} style={{ top }} onClick={onClick}>
        <span className={`explorer-twistie is-collapsible${row.collapsed ? ' is-collapsed' : ''}`} style={{ paddingLeft: indent }}>
          <Codicon name="chevron-down" />
        </span>
        <span className="explorer-label">{row.name}</span>
      </div>
    )
  const mark = scmMark(row.change.status)
  const decoration = GIT_DECORATION[mark]
  return (
    <div
      className={`explorer-row scm-file${selected ? ' is-selected' : ''}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      data-scm-file={row.change.rel}
      data-scm-status={row.change.status}
      data-git={mark}
      style={{ top }}
      title={scmRowTitle(row.change)}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <span className="explorer-twistie" style={{ paddingLeft: indent }} />
      <FileIcon name={row.name} />
      <span className={`explorer-label scm-name${scmStrike(row.change.status) ? ' is-strike' : ''}`}>
        {row.name}
        {row.parent === '' ? null : <span className="scm-desc">{row.parent}</span>}
      </span>
      <span className="explorer-badge is-git scm-letter" data-scm-letter={decoration.letter} style={{ color: decoration.color }}>
        {decoration.letter}
      </span>
    </div>
  )
}
