// 탐색기 (LIFE-589 F1) — 오른쪽 패널 안. 모양·치수는 VS Code 탐색기(D10 B), 바탕·글꼴은 corral 토큰.
//
// VS Code 값 (`~/repos/etc/vscode` 1.142 — 572 `raw/coordinator/c09`):
//   행 22px(`explorerViewer.ts:80 ITEM_HEIGHT`) · 들여쓰기 8(`listService.ts:1419`) · 가이드 onHover(`:1427`)
//   twistie: padding-left = 8 + (깊이−1)×8 · 폭 16 · padding-right 6 · translateX(3px) (`abstractTree.ts:440,488` · `tree.css:45`)
//   가이드 상자: left 16px · 폭 = (깊이−1)×8 · 가이드마다 8px · border-left 1px (`tree.css:16-34`, `abstractTree.ts:489`)
//   아이콘: 폭 16 + padding-right 6 · Seti 글꼴 150% (`iconlabel.css:14` · 테마 `fonts[0].size`)
// 가상 스크롤: 행 높이가 고정이라 scrollTop 으로 창을 자른다(overscan 위아래 10). DOM 행 수 = 보이는 행 + overscan(E3ⓒ).
// 파일 한 번 클릭 = 미리보기 탭, 더블클릭 = 고정 탭(LIFE-590 F2 — `onOpenFile`). 폴더는 펼치기·접기.
// 파일 조작(LIFE-592 F4): 인라인 입력 행(새 파일·새 폴더·이름 바꾸기 — VS Code 처럼 트리 안), 행·빈 영역 우클릭 메뉴, 툴바 새 파일·새 폴더,
// 트리 안 끌어 옮기기(포인터 방식 — 탭 끌기와 같은 결, 시작 문턱 `DRAG_THRESHOLD`), OS 드롭 대상 표지(`data-explorer-root`·`data-explorer-drop-dir` — preload 가 읽는다).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { depthOf, keyAction, parentRel, projectRows, visibleRange, type ExplorerAction, type ExplorerRow } from '../../../shared/explorer.js'
import { isAtOrUnder, nameError, splitNewName } from '../../../shared/explorer-ops.js'
import { folderMarks, GIT_DECORATION, isIgnoredPath, type GitMark } from '../../../shared/explorer-git.js'
import type { ExplorerApi } from '../hooks/useExplorer.js'
import { ContextMenu, type MenuEntry } from './ContextMenu.js'
import { Codicon, FileIcon } from './ExplorerIcons.js'
import './explorer.css'

export const ROW_HEIGHT = 22
export const INDENT = 8
const OVERSCAN = 10
/** 끌기 시작 문턱(px) — 클릭 중 이만큼 안 움직이면 끌기가 아니다(E6ⓒ). 탭 끌기(`TabBar`)와 같은 크기 감각. */
export const DRAG_THRESHOLD = 6
/** 끌기 중 접힌 폴더 위에 이만큼 머무르면 펼친다(E6ⓓ — VS Code 500 ms). */
const HOVER_EXPAND_MS = 500
/** 끌기 중 가장자리 자동 스크롤 띠(px). */
const EDGE_SCROLL_BAND = 22

type ViewMenuAction = 'toggle-dotfiles' | 'toggle-ignored'
type FileOpMenuAction = 'newFile' | 'newFolder' | 'rename' | 'duplicate' | 'trash'
type RowMenuAction = ExplorerAction | 'collapse' | FileOpMenuAction
type EmptyMenuAction = 'newFile' | 'newFolder'

/** 탐색기가 부르는 파일 조작(`useFileOps`). 입력 행 확정은 실패 문구(입력 행 안에 보인다)를, 성공이면 null 을 돌려준다. */
export type ExplorerFileOps = {
  create: (input: { dir: string; name: string; kind: 'file' | 'dir' }) => Promise<string | null>
  rename: (input: { rel: string; name: string }) => Promise<string | null>
  move: (input: { from: string; toDir: string }) => Promise<void>
  trash: (rel: string) => Promise<void>
  duplicate: (rel: string) => Promise<void>
}

/** 인라인 입력 행 — 새 항목(대상 폴더 안, 폴더 우선 정렬 자리) 또는 이름 바꾸기(그 행 자리). */
type InlineEdit = { kind: 'create'; dir: string; type: 'file' | 'dir'; token: number } | { kind: 'rename'; rel: string; type: 'file' | 'dir'; token: number }

/** 트리 안 끌기 — 누른 뒤 문턱을 넘기 전(`pending`)과 끄는 중(`dragging`). */
type TreeDrag =
  | { phase: 'pending'; rel: string; x: number; y: number }
  | { phase: 'dragging'; rel: string; target: string | null }

/** 끌어 놓을 수 있는가 — 자기 자신·자기 하위·같은 부모(무동작)는 아니다(E6ⓑ). */
export function canDropOn(input: { from: string; dir: string }): boolean {
  return !isAtOrUnder(input.dir, input.from) && parentRel(input.from) !== input.dir
}

/** 새 항목 입력 행이 들어갈 자리(행 목록 안 위치) — 폴더면 그 폴더의 첫 자식 자리, 파일이면 그 폴더의 마지막 하위 폴더 묶음 뒤(VS Code 폴더 우선 정렬). */
export function createSlot(input: { rows: readonly ExplorerRow[]; dir: string; type: 'file' | 'dir' }): { index: number; depth: number } {
  const { rows, dir } = input
  const start = dir === '' ? 0 : rows.findIndex((row) => row.rel === dir) + 1
  const depth = dir === '' ? 1 : (rows[start - 1]?.depth ?? 0) + 1
  if (dir !== '' && start === 0) return { index: 0, depth: 1 }
  if (input.type === 'dir') return { index: start, depth }
  let index = start
  // 그 폴더의 직속 자식 중 폴더(와 그 펼친 하위)를 건너뛴다.
  while (index < rows.length) {
    const row = rows[index]
    if (row === undefined || !isAtOrUnder(row.rel, dir) || row.rel === dir) break
    if (row.depth === depth && row.kind !== 'dir') break
    index += 1
  }
  return { index, depth }
}

/**
 * 행 우클릭 메뉴 (E6 · LIFE-592 E1·E2·E3·E8). 묶음 순서는 VS Code 탐색기 메뉴와 같은 결 — 새로 만들기 · 경로 복사 둘 · 보기 둘 · 복제·이름 바꾸기·삭제 · 접기.
 */
export function rowMenuEntries(row: { kind: 'dir' | 'file'; expanded: boolean }): MenuEntry<RowMenuAction>[] {
  const entries: MenuEntry<RowMenuAction>[] = [
    { kind: 'item', action: 'newFile', label: '새 파일…' },
    { kind: 'item', action: 'newFolder', label: '새 폴더…' },
    { kind: 'sep', key: 'copy' },
    { kind: 'item', action: 'copyPath', label: '경로 복사' },
    { kind: 'item', action: 'copyRelativePath', label: '상대 경로 복사' },
    { kind: 'sep', key: 'reveal' },
    { kind: 'item', action: 'reveal', label: 'Finder 에서 보기' },
    { kind: 'item', action: 'openTerminal', label: '터미널에서 열기' },
    { kind: 'sep', key: 'edit' },
    { kind: 'item', action: 'duplicate', label: '복제' },
    { kind: 'item', action: 'rename', label: '이름 바꾸기' },
    { kind: 'item', action: 'trash', label: '삭제' },
  ]
  if (row.kind === 'dir') entries.push({ kind: 'sep', key: 'collapse' }, { kind: 'item', action: 'collapse', label: '폴더 접기', disabled: !row.expanded })
  return entries
}

const EMPTY_MENU: MenuEntry<EmptyMenuAction>[] = [
  { kind: 'item', action: 'newFile', label: '새 파일…' },
  { kind: 'item', action: 'newFolder', label: '새 폴더…' },
]

export function Explorer({
  explorer,
  title,
  focusToken,
  revealRequest,
  onOpenFile,
  ops,
  notify,
}: {
  explorer: ExplorerApi
  ops: ExplorerFileOps
  /** 입력 행을 바깥 클릭으로 확정했는데 실패한 경우 등 — 입력 행이 사라진 뒤의 안내. */
  notify: (message: string) => void
  /** 섹션 머리 글자 — 활성 worktree 표시 이름(VS Code 는 폴더 이름을 대문자로 싣는다). */
  title: string | null
  /** 바뀌면 트리에 포커스를 준다(⌘⇧E — 「탐색기 보이기」 는 열고 포커스). */
  focusToken: number
  /** 파일 열기(LIFE-590 E2) — 한 번 클릭·Space = 미리보기, 더블클릭·Enter·⌘↓ = 고정. 폴더는 부르지 않는다. */
  onOpenFile: (input: { rel: string; preview: boolean }) => void
  /**
   * auto reveal(LIFE-590 E6) — 바뀌면 그 행이 보이는 곳으로 스크롤한다(조상 펼침·선택은 `explorer.reveal` 이 이미 했다). 조상 목록을 읽는 동안은 행이 없으니
   * 행이 생길 때까지 기다렸다가 한 번만 스크롤한다. **포커스는 옮기지 않는다**(VS Code `revealInExplorer` 아닌 auto reveal 과 같다).
   */
  revealRequest: { rel: string; token: number } | null
}): React.JSX.Element {
  const { state, filter } = explorer
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const treeRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(0)
  const [scrollTop, setScrollTopState] = useState(state?.scrollTop ?? 0)
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number } | null>(null)
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; row: ExplorerRow } | null>(null)
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(null)
  const [edit, setEdit] = useState<InlineEdit | null>(null)
  const editToken = useRef(0)
  const [drag, setDrag] = useState<TreeDrag | null>(null)
  /** OS 파일 끌기(가져오기) 중 놓일 폴더 — 강조만(실제 드롭은 preload). */
  const [osDropDir, setOsDropDir] = useState<string | null>(null)
  /** 끌기를 놓은 직후의 click 은 열기·토글이 아니다. */
  const suppressClick = useRef(false)
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

  // 트리에 포커스가 있는지 main 에 알린다 — ⌘Z·⌘⇧Z 를 메뉴(편집 실행 취소)보다 먼저 탐색기 기록으로 보낼지 main 이 정한다(undo-routing.md). 입력 행은 트리가 아니다.
  useEffect(() => () => window.corral.explorerFocus(false), [])

  // worktree 가 바뀌면 입력 행·끌기는 버린다.
  useEffect(() => {
    setEdit(null)
    setDrag(null)
  }, [explorer.root])

  const focusTree = (): void => treeRef.current?.focus({ preventScroll: true })

  const startEdit = (next: { kind: 'create'; dir: string; type: 'file' | 'dir' } | { kind: 'rename'; rel: string; type: 'file' | 'dir' }): void => {
    editToken.current += 1
    if (next.kind === 'create' && next.dir !== '') {
      explorer.expand(next.dir)
      explorer.select(next.dir)
    }
    if (next.kind === 'rename') explorer.select(next.rel)
    setEdit({ ...next, token: editToken.current })
  }
  /** 툴바·빈 영역 새로 만들기의 대상 폴더 — 선택이 폴더면 그 폴더, 파일이면 그 부모, 없으면 루트(VS Code). */
  const createDirFromSelection = (): string => {
    const row = rows.find((item) => item.rel === selected)
    if (row === undefined) return ''
    return row.kind === 'dir' && row.link !== 'broken' && row.link !== 'outside' ? row.rel : parentRel(row.rel)
  }
  // 입력 행이 보이게 스크롤한다.
  useLayoutEffect(() => {
    if (edit === null) return
    if (edit.kind === 'create') {
      if (slot !== null) revealIndex(slot.index)
    } else revealIndex(topOf(rows.findIndex((row) => row.rel === edit.rel)) / ROW_HEIGHT)
  }, [edit?.token])

  const siblingsOf = (dir: string): readonly string[] => (state?.listings.get(dir) ?? []).map((entry) => entry.name)
  /** 입력 행 안 안내(E1ⓒ) — 이름 규칙 + 이미 있는 이름(대소문자 무시 — APFS 기본). 최종 판정은 main. */
  const validate = (value: string): string | null => {
    if (edit === null) return null
    if (edit.kind === 'rename') {
      const own = edit.rel.slice(edit.rel.lastIndexOf('/') + 1)
      const error = nameError(value)
      if (error !== null) return error
      if (value === own || value.toLowerCase() === own.toLowerCase()) return null
      return siblingsOf(parentRel(edit.rel)).some((name) => name.toLowerCase() === value.toLowerCase()) ? `'${value}' 이(가) 이미 있습니다. 다른 이름을 고르세요.` : null
    }
    const split = splitNewName(value)
    if (!split.ok) return split.error
    const first = split.parts[0] ?? ''
    // 중간 폴더가 이미 있는 폴더면 그 안으로 들어가는 것이라 막지 않는다 — 마지막 성분만 겹침을 본다(첫 성분이 마지막일 때).
    if (split.parts.length === 1 && siblingsOf(edit.dir).some((name) => name.toLowerCase() === first.toLowerCase())) return `'${first}' 이(가) 이미 있습니다. 다른 이름을 고르세요.`
    return null
  }
  const commitEdit = async (value: string): Promise<string | null> => {
    if (edit === null) return null
    if (edit.kind === 'rename') {
      const own = edit.rel.slice(edit.rel.lastIndexOf('/') + 1)
      if (value === own) return null
      return ops.rename({ rel: edit.rel, name: value })
    }
    return ops.create({ dir: edit.dir, name: value, kind: edit.type })
  }
  const closeEdit = (input: { refocus: boolean }): void => {
    setEdit(null)
    if (input.refocus) focusTree()
  }

  // --- 트리 안 끌어 옮기기 (E6) — 포인터 방식. 문서 수준에서 움직임·놓기·Esc 를 본다. ------------------------------------
  const dragRef = useRef<TreeDrag | null>(null)
  dragRef.current = drag
  const hoverTimer = useRef<{ dir: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const edgeDelta = useRef(0)
  const latestOps = useRef({ ops, explorer })
  latestOps.current = { ops, explorer }
  const dropDirAt = useCallback((x: number, y: number): string | null => {
    const hit = document.elementFromPoint(x, y)
    const scroll = scrollRef.current
    if (!(hit instanceof Element) || scroll === null || !scroll.contains(hit)) return null
    const holder = hit.closest<HTMLElement>('[data-explorer-drop-dir]')
    return holder === null ? null : (holder.dataset.explorerDropDir ?? null)
  }, [])
  const stopTimers = (): void => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current.timer)
    hoverTimer.current = null
    if (edgeTimer.current !== null) clearInterval(edgeTimer.current)
    edgeTimer.current = null
    edgeDelta.current = 0
  }
  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return
    const onMove = (event: PointerEvent): void => {
      const current = dragRef.current
      if (current === null) return
      if (current.phase === 'pending') {
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_THRESHOLD) return
      }
      const raw = dropDirAt(event.clientX, event.clientY)
      const target = raw !== null && canDropOn({ from: current.rel, dir: raw }) ? raw : null
      setDrag({ phase: 'dragging', rel: current.rel, target })
      // 접힌 폴더 위에 머무르면 펼친다.
      const row = raw === null ? undefined : rows.find((item) => item.rel === raw)
      if (row !== undefined && row.kind === 'dir' && !row.expanded && target !== null) {
        if (hoverTimer.current?.dir !== raw) {
          if (hoverTimer.current !== null) clearTimeout(hoverTimer.current.timer)
          hoverTimer.current = { dir: raw ?? '', timer: setTimeout(() => latestOps.current.explorer.expand(row.rel), HOVER_EXPAND_MS) }
        }
      } else if (hoverTimer.current !== null) {
        clearTimeout(hoverTimer.current.timer)
        hoverTimer.current = null
      }
      // 가장자리 자동 스크롤.
      const scroll = scrollRef.current
      if (scroll !== null) {
        const rect = scroll.getBoundingClientRect()
        edgeDelta.current = event.clientY < rect.top + EDGE_SCROLL_BAND ? -ROW_HEIGHT : event.clientY > rect.bottom - EDGE_SCROLL_BAND ? ROW_HEIGHT : 0
        if (edgeDelta.current !== 0 && edgeTimer.current === null) {
          edgeTimer.current = setInterval(() => {
            if (edgeDelta.current === 0 || scrollRef.current === null) return
            scrollRef.current.scrollTop += edgeDelta.current
          }, 50)
        }
      }
    }
    const onUp = (event: PointerEvent): void => {
      const current = dragRef.current
      stopTimers()
      setDrag(null)
      if (current === null || current.phase !== 'dragging') return
      suppressClick.current = true
      setTimeout(() => {
        suppressClick.current = false
      }, 0)
      const raw = dropDirAt(event.clientX, event.clientY)
      if (raw !== null && canDropOn({ from: current.rel, dir: raw })) void latestOps.current.ops.move({ from: current.rel, toDir: raw })
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      stopTimers()
      setDrag(null)
    }
    const onCancel = (): void => {
      stopTimers()
      setDrag(null)
    }
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', onCancel, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onCancel)
    return () => {
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('pointercancel', onCancel, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onCancel)
    }
  }, [dragging, dropDirAt, rows])
  const dragTarget = drag?.phase === 'dragging' ? drag.target : null
  /** 놓일 자리 강조 — 대상 폴더 행과 그 펼친 하위(VS Code 처럼 폴더 영역), 루트면 트리 전체. */
  const highlightDir = drag?.phase === 'dragging' ? dragTarget : osDropDir

  // 새 항목 입력 행 자리 — 그 뒤 행은 한 칸씩 내려간다.
  const slot = edit?.kind === 'create' ? createSlot({ rows, dir: edit.dir, type: edit.type }) : null
  const rowCount = rows.length + (slot === null ? 0 : 1)
  const topOf = (index: number): number => (slot !== null && index >= slot.index ? index + 1 : index) * ROW_HEIGHT
  const range = visibleRange({ scrollTop, viewport, rowHeight: ROW_HEIGHT, count: rows.length, overscan: OVERSCAN })
  const selected = state?.selected ?? null
  const activeGuideParent = selected === null ? null : (rows.find((row) => row.rel === selected)?.expanded === true ? selected : parentRel(selected))

  const revealIndex = useCallback((index: number) => {
    const element = scrollRef.current
    if (element === null || index < 0) return
    const top = index * ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW_HEIGHT - element.clientHeight
  }, [])

  const revealedToken = useRef(0)
  useEffect(() => {
    if (revealRequest === null || revealedToken.current === revealRequest.token) return
    const index = rows.findIndex((row) => row.rel === revealRequest.rel)
    if (index === -1) return
    revealedToken.current = revealRequest.token
    revealIndex(index)
  }, [revealRequest, rows, revealIndex])

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
    switch (action) {
      case 'collapse':
        explorer.collapse(row.rel)
        return
      case 'newFile':
      case 'newFolder':
        startEdit({ kind: 'create', dir: row.kind === 'dir' && row.link !== 'broken' && row.link !== 'outside' ? row.rel : parentRel(row.rel), type: action === 'newFile' ? 'file' : 'dir' })
        return
      case 'rename':
        startEdit({ kind: 'rename', rel: row.rel, type: row.kind })
        return
      case 'duplicate':
        void ops.duplicate(row.rel)
        return
      case 'trash':
        void ops.trash(row.rel)
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
    // ⌘↓ — VS Code macOS 「열기」(explorer.openAndPassFocus). 파일만, 고정 탭으로.
    if (event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'ArrowDown') {
      const row = rows.find((item) => item.rel === selected)
      if (row === undefined || row.kind !== 'file') return
      event.preventDefault()
      event.stopPropagation()
      onOpenFile({ rel: row.rel, preview: false })
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
      case 'open':
        onOpenFile({ rel: action.rel, preview: action.preview })
        return
      case 'rename': {
        const row = rows.find((item) => item.rel === action.rel)
        if (row !== undefined) startEdit({ kind: 'rename', rel: row.rel, type: row.kind })
        return
      }
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
          <button
            type="button"
            className="explorer-tool"
            data-explorer-new-file=""
            title="새 파일…"
            aria-label="새 파일"
            disabled={explorer.root === null}
            onClick={() => startEdit({ kind: 'create', dir: createDirFromSelection(), type: 'file' })}
          >
            <Codicon name="new-file" />
          </button>
          <button
            type="button"
            className="explorer-tool"
            data-explorer-new-folder=""
            title="새 폴더…"
            aria-label="새 폴더"
            disabled={explorer.root === null}
            onClick={() => startEdit({ kind: 'create', dir: createDirFromSelection(), type: 'dir' })}
          >
            <Codicon name="new-folder" />
          </button>
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
        className={`explorer-scroll${highlightDir === '' ? ' is-drop-root' : ''}${drag?.phase === 'dragging' ? ' is-dragging' : ''}`}
        ref={scrollRef}
        // OS 드롭(E7) 대상 표지 — preload 가 드롭 지점에서 가장 가까운 폴더 표지와 이 루트를 읽는다. 빈 영역 = 루트('').
        data-explorer-root={explorer.root ?? ''}
        data-explorer-drop-dir=""
        onScroll={(event) => {
          const value = event.currentTarget.scrollTop
          setScrollTopState(value)
          explorer.setScrollTop(value)
        }}
        onContextMenu={(event) => {
          // 행 밖 빈 영역 — 루트에 새로 만들기(E1ⓐ).
          if (event.target instanceof Element && event.target.closest('[data-explorer-row]') !== null) return
          event.preventDefault()
          if (explorer.root === null) return
          window.corral.activateWindow()
          setEmptyMenu({ x: event.clientX, y: event.clientY })
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          const holder = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-explorer-drop-dir]') : null
          setOsDropDir(holder?.dataset.explorerDropDir ?? null)
        }}
        onDragLeave={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
          setOsDropDir(null)
        }}
        onDrop={() => setOsDropDir(null)}
      >
        <div
          className="explorer-tree"
          ref={treeRef}
          role="tree"
          tabIndex={0}
          data-explorer-tree=""
          aria-label="파일 탐색기"
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            if (event.target === event.currentTarget) window.corral.explorerFocus(true)
          }}
          onBlur={(event) => {
            if (event.target === event.currentTarget) window.corral.explorerFocus(false)
          }}
          // 클릭 포커스가 트리 상자를 「보이게」 스크롤하지 않게 — 키 포커스는 주되 스크롤 위치는 그대로 둔다.
          onMouseDown={(event) => {
            if (event.button !== 0) return
            if (event.target instanceof Element && event.target.closest('[data-inline-rename]') !== null) return
            event.preventDefault()
            treeRef.current?.focus({ preventScroll: true })
          }}
          style={{ height: rowCount * ROW_HEIGHT }}
        >
          {slot === null || edit?.kind !== 'create' ? null : (
            <div className="explorer-row is-editing" data-explorer-input-row={edit.type} style={{ top: slot.index * ROW_HEIGHT }}>
              <span className="explorer-twistie" style={{ paddingLeft: INDENT + (slot.depth - 1) * INDENT }}>
                {edit.type === 'dir' ? <Codicon name="chevron-down" className="is-placeholder" /> : null}
              </span>
              {edit.type === 'file' ? <FileIcon name="" /> : null}
              <InlineInput
                key={edit.token}
                initial=""
                selectEnd={0}
                validate={validate}
                onCommit={commitEdit}
                onClose={closeEdit}
                notify={notify}
              />
            </div>
          )}
          {rows.slice(range.start, range.end).map((row, offset) => (
            <ExplorerRowView
              key={row.rel}
              row={row}
              top={topOf(range.start + offset)}
              selected={row.rel === selected}
              activeGuideParent={activeGuideParent}
              error={state?.errors.get(row.rel) ?? null}
              mark={git?.marks.get(row.rel) ?? (row.kind === 'dir' ? (folders.get(row.rel) ?? null) : null)}
              dropTarget={highlightDir !== null && highlightDir !== '' && isAtOrUnder(row.rel, highlightDir)}
              dragSource={drag?.phase === 'dragging' && drag.rel === row.rel}
              editor={
                edit?.kind === 'rename' && edit.rel === row.rel ? (
                  <InlineInput
                    key={edit.token}
                    initial={row.name}
                    selectEnd={row.kind === 'file' && row.name.lastIndexOf('.') > 0 ? row.name.lastIndexOf('.') : row.name.length}
                    validate={validate}
                    onCommit={commitEdit}
                    onClose={closeEdit}
                    notify={notify}
                  />
                ) : null
              }
              onPointerDown={(event) => {
                if (event.button !== 0 || edit !== null) return
                setDrag({ phase: 'pending', rel: row.rel, x: event.clientX, y: event.clientY })
              }}
              onClick={() => {
                if (suppressClick.current) return
                explorer.select(row.rel)
                if (row.kind === 'dir') explorer.toggle(row.rel)
                else onOpenFile({ rel: row.rel, preview: true })
              }}
              onDoubleClick={() => {
                if (suppressClick.current) return
                if (row.kind === 'file') onOpenFile({ rel: row.rel, preview: false })
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
      {emptyMenu === null ? null : (
        <ContextMenu
          x={emptyMenu.x}
          y={emptyMenu.y}
          entries={EMPTY_MENU}
          attrs={{ 'data-explorer-empty-menu': '' }}
          onClose={() => setEmptyMenu(null)}
          onAction={(action) => {
            setEmptyMenu(null)
            startEdit({ kind: 'create', dir: '', type: action === 'newFile' ? 'file' : 'dir' })
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
  dropTarget,
  dragSource,
  editor,
  onPointerDown,
  onClick,
  onDoubleClick,
  onContextMenu,
}: {
  row: ExplorerRow
  top: number
  selected: boolean
  activeGuideParent: string | null
  error: string | null
  /** git 상태 — 파일은 자기 것, 폴더는 하위 전파(우선순위). ignored 는 행 흐림으로 따로. */
  mark: GitMark | null
  /** 끌기 중 놓일 폴더 영역(E6ⓐ). */
  dropTarget: boolean
  dragSource: boolean
  /** 이름 바꾸기 입력 행(이 행 자리) — 있으면 이름 대신 입력을 그린다. */
  editor: React.ReactNode
  onPointerDown: (event: React.PointerEvent) => void
  onClick: () => void
  onDoubleClick: () => void
  onContextMenu: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const decoration = mark === null ? null : GIT_DECORATION[mark]
  const indentSize = INDENT + (row.depth - 1) * INDENT
  // 가이드 k(0부터) = 깊이 k+1 조상 폴더의 세로줄. 활성 = 선택 항목의 부모(VS Code activeIndentNodes 와 같은 결).
  const ancestors: string[] = []
  for (let rel = parentRel(row.rel); rel !== ''; rel = parentRel(rel)) ancestors.unshift(rel)
  return (
    <div
      className={`explorer-row${selected ? ' is-selected' : ''}${row.ignored ? ' is-ignored' : ''}${dropTarget ? ' is-drop-target' : ''}${dragSource ? ' is-drag-source' : ''}${editor === null ? '' : ' is-editing'}`}
      role="treeitem"
      aria-level={row.depth}
      aria-expanded={row.kind === 'dir' ? row.expanded : undefined}
      aria-selected={selected}
      data-explorer-row={row.rel}
      data-depth={depthOf(row.rel)}
      style={{ top }}
      data-git={mark ?? undefined}
      data-ignored={row.ignored ? '' : undefined}
      // OS 드롭(E7) — 폴더 행 = 그 폴더, 파일 행 = 그 부모.
      data-explorer-drop-dir={row.kind === 'dir' ? row.rel : parentRel(row.rel)}
      onPointerDown={onPointerDown}
      title={error ?? (decoration === null ? undefined : `${row.name} • ${decoration.title}`)}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
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
      {editor ?? (
        <span className="explorer-label" style={decoration === null || row.ignored ? undefined : { color: decoration.color }}>
          {row.name}
        </span>
      )}
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

/**
 * 인라인 입력 (E1ⓑ·E2ⓑ — VS Code 탐색기 입력 상자). Enter 확정(조합 중 Enter 는 조합만 끝낸다) · Esc 취소 · 바깥 클릭(blur) = 유효하면 확정, 아니면 취소(VS Code).
 * 입력 중 키는 트리·앱 단축키로 새지 않는다 — 트리 keydown 으로 올라가지 않게 막고, 앱 단축키는 `data-inline-rename` 에서 비킨다(useKeybindings).
 * 확정 실패(이미 있음 등 main 판정)는 입력 행 안에 남겨 고치게 한다. blur 확정이 실패하면 입력 행을 닫고 알린다.
 */
function InlineInput({
  initial,
  selectEnd,
  validate,
  onCommit,
  onClose,
  notify,
}: {
  initial: string
  /** 처음 선택 끝 — 이름 바꾸기는 확장자 앞까지(VS Code). */
  selectEnd: number
  validate: (value: string) => string | null
  onCommit: (value: string) => Promise<string | null>
  onClose: (input: { refocus: boolean }) => void
  notify: (message: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const settled = useRef(false)
  useLayoutEffect(() => {
    const input = inputRef.current
    if (input === null) return
    input.focus({ preventScroll: true })
    input.setSelectionRange(0, selectEnd)
  }, [])
  const warning = failure ?? (value === initial && initial !== '' ? null : value === '' ? null : validate(value))
  const commit = async (via: 'enter' | 'blur'): Promise<void> => {
    if (settled.current || busy) return
    if (value === '' || (value === initial && initial !== '')) {
      settled.current = true
      onClose({ refocus: via === 'enter' })
      return
    }
    if (validate(value) !== null) {
      if (via === 'blur') {
        settled.current = true
        onClose({ refocus: false })
      }
      return
    }
    setBusy(true)
    const error = await onCommit(value)
    setBusy(false)
    if (error === null) {
      settled.current = true
      onClose({ refocus: via === 'enter' })
      return
    }
    if (via === 'blur') {
      settled.current = true
      onClose({ refocus: false })
      notify(error)
      return
    }
    setFailure(error)
    inputRef.current?.focus({ preventScroll: true })
  }
  return (
    <span className="explorer-input-box">
      <input
        ref={inputRef}
        className={`explorer-input${warning === null ? '' : ' is-invalid'}`}
        data-inline-rename=""
        data-explorer-input=""
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={warning !== null}
        disabled={busy}
        onChange={(event) => {
          setValue(event.target.value)
          setFailure(null)
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // 트리 키(화살표·Enter·⌘↓…)로 올라가지 않는다.
          event.stopPropagation()
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter') {
            event.preventDefault()
            void commit('enter')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            settled.current = true
            onClose({ refocus: true })
          }
        }}
        onBlur={() => void commit('blur')}
      />
      {warning === null ? null : (
        <span className="explorer-input-message" data-explorer-input-message="" role="alert">
          {warning}
        </span>
      )}
    </span>
  )
}
