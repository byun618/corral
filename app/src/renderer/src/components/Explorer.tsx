// 탐색기 (LIFE-589 F1) — 오른쪽 패널 안. 모양·치수는 VS Code 탐색기(D10 B), 바탕·글꼴은 corral 토큰.
//
// VS Code 값 (`~/repos/etc/vscode` 1.142 — 572 `raw/coordinator/c09`):
//   행 22px(`explorerViewer.ts:80 ITEM_HEIGHT`) · 들여쓰기 8(`listService.ts:1419`) · 가이드 onHover(`:1427`)
//   twistie: padding-left = 8 + (깊이−1)×8 · 폭 16 · padding-right 6 · translateX(3px) (`abstractTree.ts:440,488` · `tree.css:45`)
//   가이드 상자: left 16px · 폭 = (깊이−1)×8 · 가이드마다 8px · border-left 1px (`tree.css:16-34`, `abstractTree.ts:489`)
//   아이콘: 폭 16 + padding-right 6 · Seti 글꼴 150% (`iconlabel.css:14` · 테마 `fonts[0].size`)
// 가상 스크롤: 행 높이가 고정이라 scrollTop 으로 창을 자른다(overscan 위아래 10). DOM 행 수 = 보이는 행 + overscan(E3ⓒ).
// 파일을 눌러도 열지 않는다 — 선택만(열기는 F2).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { depthOf, keyAction, parentRel, projectRows, visibleRange, type ExplorerAction, type ExplorerRow } from '../../../shared/explorer.js'
import { folderMarks, GIT_DECORATION, isIgnoredPath, type GitMark } from '../../../shared/explorer-git.js'
import type { ExplorerApi } from '../hooks/useExplorer.js'
import { ContextMenu, type MenuEntry } from './ContextMenu.js'
import { Codicon, FileIcon } from './ExplorerIcons.js'
import './explorer.css'

export const ROW_HEIGHT = 22
export const INDENT = 8
const OVERSCAN = 10

type ViewMenuAction = 'toggle-dotfiles' | 'toggle-ignored'
type RowMenuAction = ExplorerAction | 'collapse'

/**
 * 행 우클릭 메뉴 (E6) — 비파괴 항목만. 파괴적 항목(새 파일·이름 변경·삭제)은 F4 이고 **비활성 자리로도 두지 않는다**(지금 누를 수 없는 것을 보이지 않게).
 * 순서는 VS Code 탐색기 메뉴의 묶음(경로 복사 둘 · 보기 둘 · 접기)과 같다.
 */
export function rowMenuEntries(row: { kind: 'dir' | 'file'; expanded: boolean }): MenuEntry<RowMenuAction>[] {
  const entries: MenuEntry<RowMenuAction>[] = [
    { kind: 'item', action: 'copyPath', label: '경로 복사' },
    { kind: 'item', action: 'copyRelativePath', label: '상대 경로 복사' },
    { kind: 'sep', key: 'reveal' },
    { kind: 'item', action: 'reveal', label: 'Finder 에서 보기' },
    { kind: 'item', action: 'openTerminal', label: '터미널에서 열기' },
  ]
  if (row.kind === 'dir') entries.push({ kind: 'sep', key: 'collapse' }, { kind: 'item', action: 'collapse', label: '폴더 접기', disabled: !row.expanded })
  return entries
}

export function Explorer({
  explorer,
  title,
  focusToken,
}: {
  explorer: ExplorerApi
  /** 섹션 머리 글자 — 활성 worktree 표시 이름(VS Code 는 폴더 이름을 대문자로 싣는다). */
  title: string | null
  /** 바뀌면 트리에 포커스를 준다(⌘⇧E — 「탐색기 보이기」 는 열고 포커스). */
  focusToken: number
}): React.JSX.Element {
  const { state, filter } = explorer
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const treeRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(0)
  const [scrollTop, setScrollTopState] = useState(state?.scrollTop ?? 0)
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number } | null>(null)
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; row: ExplorerRow } | null>(null)
  const git = state?.git ?? null
  const folders = useMemo(() => (git === null ? new Map<string, GitMark>() : folderMarks(git.marks)), [git])
  const isIgnored = useCallback((rel: string) => git !== null && isIgnoredPath(git.ignored, rel), [git])

  const rows = useMemo<ExplorerRow[]>(
    () => (state === null ? [] : projectRows({ listings: state.listings, expanded: state.expanded, filter, isIgnored })),
    // explorer.version 이 바뀌면 같은 Map 객체 안 내용이 바뀐 것이다(그래서 의존성에 둔다).
    [state, filter, isIgnored, explorer.version],
  )

  // worktree 를 바꾸면 그 worktree 의 스크롤 위치로 돌아간다(E2ⓘ). 패널을 다시 열 때도 같다(E1ⓔ).
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const saved = state?.scrollTop ?? 0
    element.scrollTop = saved
    setScrollTopState(saved)
  }, [explorer.root, state])

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const observer = new ResizeObserver(() => setViewport(element.clientHeight))
    observer.observe(element)
    setViewport(element.clientHeight)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (focusToken > 0) treeRef.current?.focus({ preventScroll: true })
  }, [focusToken])

  const range = visibleRange({ scrollTop, viewport, rowHeight: ROW_HEIGHT, count: rows.length, overscan: OVERSCAN })
  const selected = state?.selected ?? null
  const activeGuideParent = selected === null ? null : (rows.find((row) => row.rel === selected)?.expanded === true ? selected : parentRel(selected))

  const revealIndex = useCallback((index: number) => {
    const element = scrollRef.current
    if (element === null) return
    const top = index * ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW_HEIGHT - element.clientHeight
  }, [])

  const openRowMenuAtSelection = (): void => {
    const index = rows.findIndex((row) => row.rel === selected)
    const row = rows[index]
    const element = scrollRef.current
    if (row === undefined || element === null) return
    revealIndex(index)
    const rect = element.getBoundingClientRect()
    setRowMenu({ x: rect.left + 24 + row.depth * INDENT, y: rect.top + (index + 1) * ROW_HEIGHT - element.scrollTop, row })
  }

  const runRowAction = (action: RowMenuAction, row: ExplorerRow): void => {
    if (action === 'collapse') {
      explorer.collapse(row.rel)
      return
    }
    if (explorer.root === null) return
    void window.corral.explorerAction({ action, root: explorer.root, rel: row.rel, isDir: row.kind === 'dir' })
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // VS Code 와 같은 키로 메뉴 — ⇧F10 · Context Menu 키(E6ⓓ).
    if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      event.preventDefault()
      event.stopPropagation()
      openRowMenuAtSelection()
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const action = keyAction({ key: event.key, rows, selected })
    if (action.kind === 'none') return
    event.preventDefault()
    event.stopPropagation()
    switch (action.kind) {
      case 'select': {
        explorer.select(action.rel)
        revealIndex(rows.findIndex((row) => row.rel === action.rel))
        return
      }
      case 'expand':
        explorer.select(action.rel)
        explorer.expand(action.rel)
        return
      case 'collapse':
        explorer.select(action.rel)
        explorer.collapse(action.rel)
        return
    }
  }

  const viewEntries: MenuEntry<ViewMenuAction>[] = [
    { kind: 'item', action: 'toggle-dotfiles', label: `${filter.showDotfiles ? '✓ ' : ''}점 파일 보이기` },
    { kind: 'item', action: 'toggle-ignored', label: `${filter.showIgnored ? '✓ ' : ''}Git 제외 파일 보이기` },
  ]

  return (
    <div className="explorer" data-explorer="">
      <div className="explorer-section-head" data-explorer-section-head="">
        <span className="explorer-section-twistie">
          <Codicon name="chevron-down" />
        </span>
        <span className="explorer-section-title" title={explorer.root ?? undefined}>
          {title ?? '열린 워크트리 없음'}
        </span>
        <div className="explorer-toolbar" data-explorer-toolbar="">
          <button type="button" className="explorer-tool" data-explorer-refresh="" title="새로고침" aria-label="새로고침" disabled={explorer.root === null} onClick={explorer.refresh}>
            <Codicon name="refresh" />
          </button>
          <button type="button" className="explorer-tool" data-explorer-collapse-all="" title="모두 접기" aria-label="모두 접기" disabled={explorer.root === null} onClick={explorer.collapseAll}>
            <Codicon name="collapse-all" />
          </button>
          <button
            type="button"
            className="explorer-tool"
            data-explorer-view-menu=""
            title="보기"
            aria-label="보기"
            onClick={(event) => {
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              setViewMenu(viewMenu === null ? { x: rect.left, y: rect.bottom } : null)
            }}
          >
            <Codicon name="ellipsis" />
          </button>
        </div>
      </div>
      <div
        className="explorer-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const value = event.currentTarget.scrollTop
          setScrollTopState(value)
          explorer.setScrollTop(value)
        }}
      >
        <div
          className="explorer-tree"
          ref={treeRef}
          role="tree"
          tabIndex={0}
          data-explorer-tree=""
          aria-label="파일 탐색기"
          onKeyDown={onKeyDown}
          // 클릭 포커스가 트리 상자를 「보이게」 스크롤하지 않게 — 키 포커스는 주되 스크롤 위치는 그대로 둔다.
          onMouseDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            treeRef.current?.focus({ preventScroll: true })
          }}
          style={{ height: rows.length * ROW_HEIGHT }}
        >
          {rows.slice(range.start, range.end).map((row, offset) => (
            <ExplorerRowView
              key={row.rel}
              row={row}
              top={(range.start + offset) * ROW_HEIGHT}
              selected={row.rel === selected}
              activeGuideParent={activeGuideParent}
              error={state?.errors.get(row.rel) ?? null}
              mark={git?.marks.get(row.rel) ?? (row.kind === 'dir' ? (folders.get(row.rel) ?? null) : null)}
              onClick={() => {
                explorer.select(row.rel)
                if (row.kind === 'dir') explorer.toggle(row.rel)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                window.corral.activateWindow()
                explorer.select(row.rel)
                treeRef.current?.focus({ preventScroll: true })
                setRowMenu({ x: event.clientX, y: event.clientY, row })
              }}
            />
          ))}
        </div>
        {explorer.root !== null && state !== null && !state.listings.has('') && state.errors.has('') ? (
          <div className="explorer-empty" data-explorer-error="">{state.errors.get('')}</div>
        ) : null}
      </div>
      {rowMenu === null ? null : (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          entries={rowMenuEntries(rowMenu.row)}
          attrs={{ 'data-explorer-row-menu': rowMenu.row.rel }}
          onClose={() => {
            setRowMenu(null)
            treeRef.current?.focus({ preventScroll: true })
          }}
          onAction={(action) => {
            const row = rowMenu.row
            setRowMenu(null)
            treeRef.current?.focus({ preventScroll: true })
            runRowAction(action, row)
          }}
        />
      )}
      {viewMenu === null ? null : (
        <ContextMenu
          x={viewMenu.x}
          y={viewMenu.y}
          entries={viewEntries}
          attrs={{ 'data-explorer-view-menu-panel': '' }}
          toggleSelector="[data-explorer-view-menu]"
          onClose={() => setViewMenu(null)}
          onAction={(action) => {
            setViewMenu(null)
            if (action === 'toggle-dotfiles') explorer.setFilter({ showDotfiles: !filter.showDotfiles })
            else explorer.setFilter({ showIgnored: !filter.showIgnored })
          }}
        />
      )}
    </div>
  )
}

function ExplorerRowView({
  row,
  top,
  selected,
  activeGuideParent,
  error,
  mark,
  onClick,
  onContextMenu,
}: {
  row: ExplorerRow
  top: number
  selected: boolean
  activeGuideParent: string | null
  error: string | null
  /** git 상태 — 파일은 자기 것, 폴더는 하위 전파(우선순위). ignored 는 행 흐림으로 따로. */
  mark: GitMark | null
  onClick: () => void
  onContextMenu: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const decoration = mark === null ? null : GIT_DECORATION[mark]
  const indentSize = INDENT + (row.depth - 1) * INDENT
  // 가이드 k(0부터) = 깊이 k+1 조상 폴더의 세로줄. 활성 = 선택 항목의 부모(VS Code activeIndentNodes 와 같은 결).
  const ancestors: string[] = []
  for (let rel = parentRel(row.rel); rel !== ''; rel = parentRel(rel)) ancestors.unshift(rel)
  return (
    <div
      className={`explorer-row${selected ? ' is-selected' : ''}${row.ignored ? ' is-ignored' : ''}`}
      role="treeitem"
      aria-level={row.depth}
      aria-expanded={row.kind === 'dir' ? row.expanded : undefined}
      aria-selected={selected}
      data-explorer-row={row.rel}
      data-depth={depthOf(row.rel)}
      style={{ top }}
      data-git={mark ?? undefined}
      data-ignored={row.ignored ? '' : undefined}
      title={error ?? (decoration === null ? undefined : `${row.name} • ${decoration.title}`)}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="explorer-indent" style={{ width: (row.depth - 1) * INDENT }}>
        {ancestors.map((rel) => (
          <div key={rel} className={`explorer-indent-guide${rel === activeGuideParent ? ' is-active' : ''}`} style={{ width: INDENT }} />
        ))}
      </div>
      <span className={`explorer-twistie${row.kind === 'dir' ? ' is-collapsible' : ''}${row.expanded ? '' : ' is-collapsed'}`} style={{ paddingLeft: indentSize }}>
        {row.kind === 'dir' && row.link !== 'broken' && row.link !== 'outside' ? <Codicon name="chevron-down" /> : null}
      </span>
      {row.kind === 'file' ? <FileIcon name={row.name} /> : null}
      <span className="explorer-label" style={decoration === null || row.ignored ? undefined : { color: decoration.color }}>
        {row.name}
      </span>
      {row.link === 'none' ? null : (
        <span className="explorer-badge is-link" data-explorer-link={row.link} title={row.link === 'ok' ? '심볼릭 링크' : row.link === 'outside' ? '심볼릭 링크 — 워크트리 밖(펼치지 않음)' : '심볼릭 링크 — 대상 없음'}>
          {'⤷'}
        </span>
      )}
      {decoration === null ? null : row.kind === 'file' ? (
        <span className="explorer-badge is-git" data-explorer-git-badge={mark ?? ''} style={{ color: decoration.color }}>
          {decoration.letter}
        </span>
      ) : (
        <span className="explorer-badge is-bubble" data-explorer-git-bubble={mark ?? ''} style={{ color: decoration.color }} aria-hidden>
          <Codicon name="circle-filled" />
        </span>
      )}
    </div>
  )
}
