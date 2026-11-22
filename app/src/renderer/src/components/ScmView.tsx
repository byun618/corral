// 소스 제어 보기 (LIFE-683 S2~S4·S9) — 오른쪽 패널 몸통. 변경 목록 + 클릭 = diff 탭.
// 쓰기(LIFE-829): 머리 아래 메시지 입력란 + 커밋 단추(▾ 「커밋(수정)」), 행·그룹 inline 단추(VS Code V1·V2 — 행 hover·선택 때 보인다). 확인 대화상자는 main.
//
// · 모양은 VS Code SCM 보기(`scmViewPane.ts`) — 그룹 머리(twistie · 제목 · 오른쪽 개수), 22px 행(파일 아이콘 · 이름 · 흐린 부모 경로 · 오른쪽 상태 글자).
//   글자·색은 탐색기 배지와 같은 표(`GIT_DECORATION`), 이름은 기본 글자색(VS Code `fileDecorations.colors: false`), 삭제는 취소선.
// · 목록 / 트리(폴더 압축) 전환은 머리 단추 — 선택은 ui-prefs `scmViewMode` 에 영속(Q6). 접기 상태는 메모리(VS Code 와 같다 — 세션 동안).
// · 행이 많을 수 있어(상한 10 000 — `git.statusLimit`) 22px 고정 높이로 보이는 칸만 그린다.
// · 키보드는 탐색기와 같은 관례: ↑↓ Home End 이동 · ← 접기/부모 · → 펼치기 · Enter 열기(고정) · Space 열기(미리보기).
// · 비교 기준(LIFE-830) — 머리 단추로 「작업 트리」 ↔ 「base 대비」(루트별, `scm.compare`). base 대비는 그룹 하나(merge-base ↔ 작업 트리 + 추적 안 함)와
//   머리 아래 한 줄(base 이름 · 출처 · merge-base 짧은 해시 — 이름만 줄고 출처·해시는 안 준다)을 그린다. 목록·트리·정렬·접기·키보드·상한은 같은 장치.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GIT_DECORATION } from '../../../shared/explorer-git.js'
import {
  buildTree,
  flattenTree,
  groupChanges,
  SCM_BASE_SOURCE_TEXT,
  SCM_NO_BASE_HELP,
  SCM_STATUS_LIMIT,
  scmErrorKind,
  SCM_STATUS_TEXT,
  scmMark,
  scmStrike,
  type ScmBasePush,
  type ScmChange,
  type ScmGroupId,
} from '../../../shared/scm.js'
import { discardRequest, stageRequest } from '../../../shared/scm-write.js'
import type { ScmApi } from '../hooks/useScm.js'
import { Codicon, FileIcon, type CodiconName } from './ExplorerIcons.js'
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

/**
 * 파일 줄 key — 그룹 + 경로. base 대비 그룹은 같은 경로가 두 줄(diff 의 `D` + 같은 경로의 추적 안 함 `U`)일 수 있어 상태를 더한다(LIFE-830 수정 r1 A1).
 * 작업 트리 그룹은 그룹 안에서 경로가 하나라 그대로 둔다(선택·접기 키 무변경).
 */
const fileKey = ({ group, change }: { group: ScmChange['group']; change: ScmChange }): string => (group === 'base' ? `f:base:${change.status}:${change.rel}` : `f:${group}:${change.rel}`)

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
      for (const change of group.changes) rows.push({ kind: 'file', key: fileKey({ group: group.id, change }), group: group.id, change, name: nameOf(change.rel), parent: parentOf(change.rel), depth: 1 })
      continue
    }
    const dirCollapsed = new Set([...input.collapsed].filter((key) => key.startsWith(`d:${group.id}:`)).map((key) => key.slice(`d:${group.id}:`.length)))
    for (const row of flattenTree(buildTree(group.changes), dirCollapsed)) {
      if (row.kind === 'dir') rows.push({ kind: 'dir', key: `d:${group.id}:${row.path}`, group: group.id, name: row.name, path: row.path, depth: row.depth, collapsed: row.collapsed })
      else rows.push({ kind: 'file', key: fileKey({ group: group.id, change: row.change }), group: group.id, change: row.change, name: row.name, parent: '', depth: row.depth })
    }
  }
  return { rows, total: grouped.total, truncated: grouped.truncated }
}

export type ScmActionId = 'discard' | 'stage' | 'unstage'

/** 행·그룹 inline 단추 — VS Code `package.json` `scm/resourceState/context`·`scm/resourceGroup/context` inline(V1·V2, 「파일 열기」·「변경 보기」 는 뺀다 — D1). */
export function scmActionsOf(group: ScmGroupId): ScmActionId[] {
  switch (group) {
    case 'workingTree':
      return ['discard', 'stage']
    case 'index':
      return ['unstage']
    case 'merge':
      return ['stage']
    case 'base':
      return []
  }
}

const ACTION_ICON: Readonly<Record<ScmActionId, CodiconName>> = { discard: 'discard', stage: 'add', unstage: 'remove' }
const ACTION_TITLE: Readonly<Record<ScmActionId, { row: string; group: string }>> = {
  discard: { row: '변경 내용 취소', group: '모든 변경 내용 취소' },
  stage: { row: '변경 내용 스테이징', group: '모든 변경 내용 스테이징' },
  unstage: { row: '변경 내용 스테이징 취소', group: '모든 변경 내용 스테이징 취소' },
}
/** 목록이 상한에서 잘렸을 때 그룹 단추는 보이는 것만 처리하게 되므로 끈다(D2 — 행 단추는 그대로). `disabled` 는 툴팁이 안 떠서 `aria-disabled`. */
export const SCM_GROUP_TRUNCATED_TITLE = '변경이 너무 많아 목록이 잘렸습니다 — 그룹 전체 동작은 쓸 수 없습니다(파일별로 하거나 터미널에서 하세요).'

/** 행 툴팁 — 경로 • 상태 문구, 이름 바뀜은 원래 경로(VS Code `getStatusText` + 원래 경로). */
export function scmRowTitle(change: ScmChange): string {
  const status = SCM_STATUS_TEXT[change.status]
  return change.orig === null ? `${change.rel} • ${status}` : `${change.rel} • ${status} (원래 ${change.orig})`
}

/** base 대비 모드의 안내 — 목록을 그릴 수 있으면 null(빈 목록 문구는 따로). */
export function scmBaseNotice(base: ScmBasePush | null): string | null {
  if (base === null) return 'base 대비 목록을 읽는 중…'
  if (base.ok) return base.changes.length === 0 ? 'base 대비 변경 사항 없음' : null
  switch (base.reason) {
    case 'no_base':
      return SCM_NO_BASE_HELP
    case 'no_merge_base':
      return `base 와 공통 조상이 없어 비교할 수 없습니다 — ${base.error}`
    case 'git_error':
      return `base 대비 목록을 읽지 못했습니다 — ${base.error}`
  }
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
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [height, setHeight] = useState(400)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const root = scm.root
  const compare = scm.compare
  const base = scm.state?.base ?? null
  const changes = compare === 'base' ? (base !== null && base.ok ? base.changes : null) : (scm.state?.changes ?? null)
  const collapsed = useMemo(() => (root === null ? new Set<string>() : (collapsedByRoot.get(root) ?? new Set<string>())), [collapsedByRoot, root])
  const selected = root === null ? null : (selectedByRoot.get(root) ?? null)
  const changesTotal = compare === 'base' ? (base !== null && base.ok ? base.total : 0) : (scm.state?.total ?? 0)
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

  // 쓰기 — 요청의 루트는 누른 때 값이다(K12). 결과는 `scm.run` 이 그 루트의 상태에만 적용한다.
  // base 대비(LIFE-830)는 읽기 전용 — 쓰기 단추·입력란을 그리지 않는다(K14·B8). 숨김은 상태를 지우지 않는다(초안·안내·진행 중 쓰기는 루트 상태에 그대로).
  const writable = compare !== 'base'
  const act = (input: { action: ScmActionId; group: ScmGroupId; changes: readonly ScmChange[] }): void => {
    if (root === null || !writable || input.changes.length === 0) return
    const request = input.action === 'discard' ? discardRequest({ root, changes: input.changes }) : stageRequest({ root, group: input.group, changes: input.changes })
    if (request !== null) void scm.run(request)
  }
  const groupChangesOf = (group: ScmGroupId): ScmChange[] => (changes ?? []).filter((change) => change.group === group)
  const commit = (amend: boolean): void => {
    setMenuOpen(false)
    if (root === null || !writable || scm.write.committing) return
    // 빈 메시지 커밋은 main 이 git 없이 거절한다(D7) — 입력란으로 포커스를 돌린다.
    if (!amend && scm.write.message.trim() === '') inputRef.current?.focus()
    void scm.run({ action: 'commit', root, message: scm.write.message, amend })
  }
  const showInput = writable && root !== null && !(scm.state !== null && scm.state.error !== null)
  const writeNotice = scm.write.notice

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
          : compare === 'base'
            ? scmBaseNotice(base)
            : changes !== null && changes.length === 0
              ? '변경 사항 없음'
              : null

  return (
    <div className="scm" data-scm="" data-scm-mode={mode} data-scm-compare={compare}>
      <div className="explorer-section-head" data-scm-head="">
        <span className="explorer-section-twistie" />
        <span className="explorer-section-title" title={title ?? undefined}>
          소스 제어
        </span>
        <div className="explorer-toolbar">
          <button
            type="button"
            className={`explorer-tool${compare === 'base' ? ' is-active' : ''}`}
            data-scm-compare-toggle={compare === 'base' ? 'working' : 'base'}
            title={compare === 'base' ? '작업 트리로 보기' : 'base 대비로 보기'}
            aria-label={compare === 'base' ? '작업 트리로 보기' : 'base 대비로 보기'}
            aria-pressed={compare === 'base'}
            disabled={root === null}
            onClick={() => scm.setCompare(compare === 'base' ? 'working' : 'base')}
          >
            <Codicon name="git-compare" />
          </button>
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
      {compare === 'base' && base !== null && base.ok ? (
        <div className="scm-base" data-scm-base="" data-scm-base-source={base.info.source} title={`base ${base.info.name} · ${SCM_BASE_SOURCE_TEXT[base.info.source]} · merge-base ${base.info.mergeBase}`}>
          <span className="scm-base-name" data-scm-base-name="">
            base {base.info.name}
          </span>
          <span className="scm-base-tail">
            <span className="scm-base-source">{SCM_BASE_SOURCE_TEXT[base.info.source]}</span>
            <span className="scm-base-hash" data-scm-base-hash={base.info.mergeBase.slice(0, 7)}>
              {base.info.mergeBase.slice(0, 7)}
            </span>
          </span>
        </div>
      ) : null}
      {showInput ? (
        <div className="scm-input" data-scm-input="">
          <textarea
            ref={inputRef}
            className="scm-message"
            data-scm-message=""
            aria-label="커밋 메시지"
            placeholder="메시지(⌘Enter 로 커밋)"
            rows={Math.min(10, Math.max(1, scm.write.message.split('\n').length))}
            value={scm.write.message}
            readOnly={scm.write.committing}
            spellCheck={false}
            onChange={(event) => scm.setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                event.preventDefault()
                commit(false)
              }
            }}
          />
          <div
            className="scm-commit-row"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && menuOpen) {
                event.preventDefault()
                setMenuOpen(false)
              }
            }}
          >
            <button type="button" className="scm-commit" data-scm-commit="" disabled={scm.write.committing} onClick={() => commit(false)}>
              <Codicon name="check" />
              <span>{scm.write.committing ? '커밋하는 중…' : '커밋'}</span>
            </button>
            <button
              type="button"
              className="scm-commit-more"
              data-scm-commit-more=""
              title="커밋 동작 더 보기"
              aria-label="커밋 동작 더 보기"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={scm.write.committing}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Codicon name="chevron-down" />
            </button>
            {menuOpen ? (
              <div className="scm-commit-menu" role="menu" data-scm-commit-menu="">
                <button type="button" role="menuitem" data-scm-commit-item="commit" onClick={() => commit(false)}>
                  커밋
                </button>
                <button type="button" role="menuitem" data-scm-commit-item="amend" onClick={() => commit(true)}>
                  커밋(수정)
                </button>
              </div>
            ) : null}
          </div>
          {writeNotice !== null ? (
            <div className={`scm-notice is-${writeNotice.kind}`} role={writeNotice.kind === 'error' ? 'alert' : 'status'} data-scm-notice={writeNotice.kind}>
              <pre className="scm-notice-text">{writeNotice.text}</pre>
              <button type="button" className="explorer-tool scm-notice-close" title="닫기" aria-label="안내 닫기" onClick={scm.dismissNotice}>
                <Codicon name="close" />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
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
                truncated={truncated}
                onAction={(action) => act({ action, group: row.group, changes: row.kind === 'file' ? [row.change] : groupChangesOf(row.group) })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** inline 단추 묶음 — 클릭·더블클릭이 행(diff 열기·접기)으로 새지 않는다. */
function ScmActions({ group, level, off, onAction }: { group: ScmGroupId; level: 'row' | 'group'; off: boolean; onAction: (action: ScmActionId) => void }): React.JSX.Element {
  return (
    <span className="scm-actions" data-scm-actions={level}>
      {scmActionsOf(group).map((action) => (
        <button
          key={action}
          type="button"
          className="scm-action"
          data-scm-action={action}
          title={off ? SCM_GROUP_TRUNCATED_TITLE : ACTION_TITLE[action][level]}
          aria-label={ACTION_TITLE[action][level]}
          aria-disabled={off ? true : undefined}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation()
            if (!off) onAction(action)
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <Codicon name={ACTION_ICON[action]} />
        </button>
      ))}
    </span>
  )
}

function ScmRowView({
  row,
  top,
  selected,
  onClick,
  onDoubleClick,
  truncated,
  onAction,
}: {
  row: ScmRow
  top: number
  selected: boolean
  onClick: () => void
  onDoubleClick: () => void
  truncated: boolean
  onAction: (action: ScmActionId) => void
}): React.JSX.Element {
  if (row.kind === 'group')
    return (
      <div className={`explorer-row scm-group${selected ? ' is-selected' : ''}`} role="treeitem" aria-level={1} aria-expanded={!row.collapsed} aria-selected={selected} data-scm-group={row.group} style={{ top }} onClick={onClick}>
        <span className={`explorer-twistie is-collapsible${row.collapsed ? ' is-collapsed' : ''}`} style={{ paddingLeft: 0 }}>
          <Codicon name="chevron-down" />
        </span>
        <span className="explorer-label scm-group-title">{row.title}</span>
        <ScmActions group={row.group} level="group" off={truncated} onAction={onAction} />
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
      <ScmActions group={row.group} level="row" off={false} onAction={onAction} />
      <span className="explorer-badge is-git scm-letter" data-scm-letter={decoration.letter} style={{ color: decoration.color }}>
        {decoration.letter}
      </span>
    </div>
  )
}
