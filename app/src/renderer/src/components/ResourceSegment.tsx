// 상태바 Resource Manager 세그먼트 (LIFE-637) — 기존 JS 힙 표시 자리에 들어가는 자기 완결 요소(자기 상태·IPC 구독·패널).
//
// 세그먼트: `CPU n% · 메모리 x.x GB`(표시 규칙 `resource-view.ts`). 클릭하면 패널.
// 패널(R4): 시스템 한 줄 · 앱·herdr 행 · worktree 묶음(합계 + pane 행). 열린 동안 main 푸시로 갱신. Esc(패널 안 포커스, 또는 포커스가 body)·바깥 클릭으로
// 닫히고 열기 전 포커스로 돌아간다. ↑↓·Home·End 로 pane 행 이동, Enter = 이동. 행이 사라지면 포커스는 이웃 행(없으면 패널)으로(F4).
// 닫기는 ✕ 버튼만(F8 — 한 키 닫기 없음).
// 행 동작(R5):
//   · 이동 = 기존 revealPane 길.
//   · 닫기 — split 탭의 pane: 기존 실행 중 확인 게이트(main `closeTabsGated`, pane 단위).
//            탭의 마지막 pane(클릭 순간의 main 위상, H3): 기존 탭 닫기 IPC(`closeTabs`) — 핀 확인(`confirmClosePinnedTab`) + 그 worktree 의 마지막 터미널 탭이면 수정 문서 확인(`confirmDiscardOrSave`)
//            을 사이드바·탭 닫기와 같은 규칙으로 먼저 지난다(F7).
//     확인 창은 기존 `ConfirmClose`, 문구는 pane 기준(`paneCloseCopy`). 뜨면 취소 버튼에 포커스, Esc = 취소(F3).
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import type { CloseTabsResult, RunningPane } from '../../../shared/types.js'
import type { ResourceCloseRoute, ResourcePaneRow, ResourceSnapshot } from '../../../shared/resource.js'
import { CLOSE_SKIP_FAILED_NOTICE } from '../close-copy.js'
import { allDocs } from '../file-docs.js'
import { confirmDiscardOrSave } from '../file-save.js'
import {
  formatCpu,
  formatMemory,
  groupPanes,
  HERDR_ROW_LABEL,
  HERDR_ROW_TOOLTIP,
  hostLine,
  measureCells,
  paneCloseCopy,
  RESOURCE_EMPTY,
  segmentLabel,
  segmentTooltip,
  type ResourceSortKey,
} from '../resource-view.js'
import { getSettings, updateSettings } from '../settings-store.js'
import { pinnedTabIds, readTabMarks } from '../tab-marks.js'
import { ConfirmClose } from './ConfirmClose.js'
import './resource.css'

/** 닫기 길 — split 탭의 pane 은 pane 게이트, 탭의 마지막 pane 은 기존 탭 닫기. */
type CloseTarget =
  | { kind: 'pane'; row: ResourcePaneRow }
  | { kind: 'tab'; row: ResourcePaneRow; tabId: string; pinned: boolean; alwaysConfirm: boolean }

type PendingClose = { target: CloseTarget; running: RunningPane[] }

const ROW_SELECTOR = '[data-statusbar-resource-row]'

async function pinnedNow(tabId: string): Promise<boolean> {
  // 핀은 App 이 바뀔 때마다 ui-prefs 에 바로 저장한다(App `savedTabMarks`) — 그 값을 읽는다.
  // 읽기에 실패하면 핀으로 본다(H4ⓐ — 모르면 묻는 쪽, 실행 중 판정의 probe 실패와 같은 방향).
  try {
    const prefs = await window.corral.getUiPrefs()
    return pinnedTabIds(readTabMarks(prefs.tabMarks)).has(tabId)
  } catch {
    return true
  }
}

export function ResourceSegment(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [sort, setSort] = useState<ResourceSortKey>('memory')
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  const [error, setError] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  /** 마지막으로 포커스가 있던 행의 자리 — 그 행이 사라지면 같은 자리(이웃)로 포커스를 옮긴다(F4). */
  const focusIndexRef = useRef(0)
  /** 확인 창을 연 행 — 취소하면 그 행으로 포커스를 돌린다. */
  const closingPaneRef = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.corral.getResourceSnapshot().then((first) => {
      if (alive && first !== null) setSnapshot((current) => current ?? first)
    })
    const stop = window.corral.onResourceSnapshot(setSnapshot)
    return () => {
      alive = false
      stop()
    }
  }, [])

  const rowsInPanel = (): HTMLElement[] => [...(panelRef.current?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? [])]

  const focusRowNear = useCallback((input: { paneId: string | null }) => {
    const panel = panelRef.current
    if (panel === null) return
    const rows = [...panel.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
    const same = input.paneId === null ? undefined : rows.find((row) => row.dataset.statusbarResourceRow === input.paneId)
    const target = same ?? rows[Math.min(focusIndexRef.current, rows.length - 1)] ?? panel
    target.focus()
  }, [])

  const closePanel = useCallback((input: { restoreFocus: boolean }) => {
    setOpen(false)
    setPendingClose(null)
    setError(null)
    if (!input.restoreFocus) return
    const target = returnFocusRef.current
    if (target !== null && target.isConnected) target.focus()
    else buttonRef.current?.focus()
  }, [])

  const cancelClose = useCallback(() => {
    setPendingClose(null)
    // 확인 창이 내려간 뒤(다음 렌더) 그 행으로.
    window.setTimeout(() => focusRowNear({ paneId: closingPaneRef.current }), 0)
  }, [focusRowNear])

  // Esc 창 캡처는 두 경우만 가져간다(H2): ⓐ 확인 창이 떠 있다(F3 — 취소) ⓑ 포커스가 body 로 떨어졌다(F4 — 패널 닫기).
  // 그 밖(팔레트·문서 캡처·터미널 textarea 등 다른 곳에 포커스)의 Esc 는 건드리지 않는다. 패널 안 포커스의 Esc 는 패널 `onKeyDown`.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      const active = document.activeElement
      if (pendingClose === null && active !== null && active !== document.body) return
      event.preventDefault()
      event.stopPropagation()
      if (pendingClose !== null) cancelClose()
      else closePanel({ restoreFocus: true })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, pendingClose, cancelClose, closePanel])

  // 바깥 클릭 — 확인 창이 떠 있는 동안은 그 창이 받는다.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (pendingClose !== null) return
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target) === true || buttonRef.current?.contains(target) === true) return
      closePanel({ restoreFocus: true })
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open, pendingClose, closePanel])

  // 열리면 첫 행(없으면 패널)으로 포커스.
  useEffect(() => {
    if (!open) return
    focusIndexRef.current = 0
    focusRowNear({ paneId: null })
  }, [open, focusRowNear])

  // 확인 창이 뜨면 취소 버튼으로(F3 — Enter·Space 가 뒤의 행 「이동」 으로 새지 않는다).
  useEffect(() => {
    if (pendingClose === null) return
    document.querySelector<HTMLElement>('[data-close-confirm-cancel]')?.focus()
  }, [pendingClose])

  // 포커스된 행이 사라져 포커스가 body 로 떨어졌으면 이웃 행(없으면 패널)으로(F4).
  useEffect(() => {
    if (!open || pendingClose !== null) return
    const active = document.activeElement
    if (active === null || active === document.body) focusRowNear({ paneId: null })
  }, [open, pendingClose, snapshot, focusRowNear])

  const toggle = (): void => {
    if (open) {
      closePanel({ restoreFocus: true })
      return
    }
    setOpen(true)
  }

  const reveal = (row: ResourcePaneRow): void => {
    void window.corral.revealResourcePane({ paneId: row.paneId }).then((ok) => {
      if (!ok) setError('그 pane 을 찾지 못했다')
    })
    // 이동하면 포커스는 그 pane 이 가져간다 — 열기 전 자리로 되돌리지 않는다.
    closePanel({ restoreFocus: false })
  }

  const runClose = async (input: { target: CloseTarget; confirmed: boolean; confirmedPaneIds: string[] }): Promise<void> => {
    const { target } = input
    let result: CloseTabsResult
    try {
      result = target.kind === 'tab'
        ? await window.corral.closeTabs({ tabIds: [target.tabId], confirmed: input.confirmed, alwaysConfirm: target.alwaysConfirm, confirmedPaneIds: input.confirmedPaneIds })
        : await window.corral.closeResourcePane({ paneId: target.row.paneId, confirmed: input.confirmed, confirmedPaneIds: input.confirmedPaneIds })
    } catch (failure) {
      setPendingClose(null)
      setError(`닫지 못했다: ${failure instanceof Error ? failure.message : String(failure)}`)
      return
    }
    switch (result.outcome) {
      case 'closed': {
        setPendingClose(null)
        // 닫은 목록에 대상이 없으면 아무것도 닫히지 않았다(F6 — 그 사이 사라졌다) — 성공으로 보이지 않는다.
        const id = target.kind === 'tab' ? target.tabId : target.row.paneId
        setError(result.closed.includes(id) ? null : '닫힌 것이 없다 — 이미 없어졌을 수 있다')
        return
      }
      case 'needs-confirm':
        setPendingClose({ target, running: result.running })
        return
      case 'rejected':
        setPendingClose(null)
        setError(result.rejection.message || result.rejection.code)
        return
      case 'error':
        setPendingClose(null)
        setError(result.error)
        return
    }
  }

  const startClose = async (row: ResourcePaneRow): Promise<void> => {
    closingPaneRef.current = row.paneId
    setError(null)
    // 길은 클릭한 지금의 위상으로 main 에 묻는다(H3 — 스냅샷은 최대 2초 낡았다: split 직후·옆 pane 소멸 직후).
    let route: ResourceCloseRoute
    try {
      route = await window.corral.getResourceCloseRoute({ paneId: row.paneId })
    } catch (failure) {
      setError(`닫지 못했다: ${failure instanceof Error ? failure.message : String(failure)}`)
      return
    }
    switch (route.kind) {
      case 'missing':
        setError('그 pane 이 없다(이미 닫혔다)')
        return
      case 'pane':
        await runClose({ target: { kind: 'pane', row }, confirmed: false, confirmedPaneIds: [] })
        return
      case 'tab': {
        // 탭의 마지막 pane — 사이드바·탭 닫기(`closeTabsByUser`)와 같은 순서: 수정 문서 → 핀·실행 중 게이트.
        if (route.lastInWorktree) {
          const saveDeps = { writeFile: window.corral.writeFile, fileDialog: window.corral.fileDialog, notify: (message: string) => toast(message) }
          const worktreePath = route.worktreePath
          const ok = await confirmDiscardOrSave({ targets: () => allDocs().filter((doc) => doc.root === worktreePath), deps: saveDeps })
          if (!ok) return
        }
        const pinned = await pinnedNow(route.tabId)
        await runClose({ target: { kind: 'tab', row, tabId: route.tabId, pinned, alwaysConfirm: getSettings().confirmClosePinnedTab && pinned }, confirmed: false, confirmedPaneIds: [] })
        return
      }
    }
  }

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (pendingClose !== null) return
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.stopPropagation()
      closePanel({ restoreFocus: true })
      return
    }
    const rows = rowsInPanel()
    if (rows.length === 0) return
    const index = rows.findIndex((row) => row === document.activeElement)
    const move = (next: number): void => {
      event.preventDefault()
      rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus()
    }
    switch (event.key) {
      case 'ArrowDown':
        move(index < 0 ? 0 : index + 1)
        return
      case 'ArrowUp':
        move(index < 0 ? rows.length - 1 : index - 1)
        return
      case 'Home':
        move(0)
        return
      case 'End':
        move(rows.length - 1)
        return
    }
  }

  const groups = snapshot === null ? [] : groupPanes({ panes: snapshot.panes, sort })
  const appCells = snapshot === null ? null : measureCells(snapshot.app)
  const herdrCells = snapshot === null ? null : measureCells(snapshot.herdr)
  const herdrTitle = herdrCells === null || herdrCells.title === null ? HERDR_ROW_TOOLTIP : `${HERDR_ROW_TOOLTIP}\n${herdrCells.title}`

  const panel = !open ? null : (
    <div
      ref={panelRef}
      className="statusbar-resource-panel"
      data-statusbar-resource-panel
      role="dialog"
      aria-label="Resource Manager"
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
    >
      <div className="statusbar-resource-head">
        <span className="statusbar-resource-title">{segmentLabel(snapshot)}</span>
        <span className="statusbar-resource-sort" role="group" aria-label="정렬">
          {(['memory', 'cpu'] satisfies ResourceSortKey[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`statusbar-resource-sort-btn${sort === key ? ' is-active' : ''}`}
              data-statusbar-resource-sort={key}
              aria-pressed={sort === key}
              onClick={() => setSort(key)}
            >
              {key === 'memory' ? '메모리순' : 'CPU순'}
            </button>
          ))}
        </span>
      </div>
      {snapshot === null ? (
        <div className="statusbar-resource-note">아직 수집 전</div>
      ) : (
        <>
          <div className="statusbar-resource-note" data-statusbar-resource-host>{hostLine(snapshot)}</div>
          <div className="statusbar-resource-line" data-statusbar-resource-app title={appCells?.title ?? undefined}>
            <span className="statusbar-resource-name">corral 앱</span>
            <span className="statusbar-resource-cpu" data-statusbar-resource-cpu>{appCells?.cpu}</span>
            <span className="statusbar-resource-mem" data-statusbar-resource-memory>{appCells?.memory}</span>
          </div>
          <div className="statusbar-resource-line" data-statusbar-resource-herdr title={herdrTitle}>
            <span className="statusbar-resource-name">{HERDR_ROW_LABEL}</span>
            <span className="statusbar-resource-cpu" data-statusbar-resource-cpu>{herdrCells?.cpu}</span>
            <span className="statusbar-resource-mem" data-statusbar-resource-memory>{herdrCells?.memory}</span>
          </div>
          {groups.length === 0 ? <div className="statusbar-resource-note">열린 pane 이 없다</div> : null}
          {groups.map((group) => (
            <div key={group.key} className="statusbar-resource-group" data-statusbar-resource-group={group.key}>
              <div className="statusbar-resource-line statusbar-resource-group-head" title={group.unavailableCount === 0 ? undefined : `측정 불가 ${group.unavailableCount}개는 합에서 빠졌다`}>
                <span className="statusbar-resource-name">{group.label}</span>
                <span className="statusbar-resource-cpu" data-statusbar-resource-cpu>{group.usage === null ? RESOURCE_EMPTY : formatCpu(group.usage.cpu)}</span>
                <span className="statusbar-resource-mem" data-statusbar-resource-memory>{group.usage === null ? RESOURCE_EMPTY : formatMemory(group.usage.memory)}</span>
              </div>
              {group.panes.map((row) => {
                const cells = measureCells(row.measure)
                return (
                  <div key={row.paneId} className="statusbar-resource-pane">
                    <button
                      type="button"
                      className="statusbar-resource-line statusbar-resource-move"
                      data-statusbar-resource-row={row.paneId}
                      title={cells.title ?? `${row.title} — 이동`}
                      onFocus={(event) => {
                        focusIndexRef.current = Math.max(0, rowsInPanel().indexOf(event.currentTarget))
                      }}
                      onClick={() => reveal(row)}
                    >
                      <span className="statusbar-resource-name">{row.title}</span>
                      <span className="statusbar-resource-agent" data-statusbar-resource-agent>{row.agent ?? 'shell'}</span>
                      <span className="statusbar-resource-cpu" data-statusbar-resource-cpu>{cells.cpu}</span>
                      <span className="statusbar-resource-mem" data-statusbar-resource-memory>{cells.memory}</span>
                    </button>
                    <button
                      type="button"
                      className="statusbar-resource-close"
                      data-statusbar-resource-close={row.paneId}
                      aria-label={`${row.title} 닫기`}
                      title="닫기"
                      onClick={() => void startClose(row)}
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </>
      )}
      {error === null ? null : <div className="statusbar-resource-error" data-statusbar-resource-error>{error}</div>}
    </div>
  )

  const confirm = pendingClose === null ? null : (() => {
    const { target, running } = pendingClose
    const { row } = target
    const copy = paneCloseCopy({ running, agentPaneIds: new Set(row.agent === null ? [] : [row.paneId]), pinned: target.kind === 'tab' && target.pinned })
    const confirmedPaneIds = running.map((pane) => pane.paneId)
    return (
      <ConfirmClose
        key={`${row.paneId}|${confirmedPaneIds.join(',')}`}
        copy={copy}
        rows={[{ key: row.paneId, label: row.title, foreground: running.flatMap((pane) => pane.foreground) }]}
        onConfirm={({ dontAskAgain }) => {
          void (async () => {
            // 기존 탭 닫기와 같다 — 체크 + 확인만 저장하고, 저장이 실패해도 사용자가 확인한 닫기는 진행한다.
            if (dontAskAgain && copy.dontAskAgain !== null && !(await updateSettings(copy.dontAskAgain.patch))) toast(CLOSE_SKIP_FAILED_NOTICE)
            await runClose({ target, confirmed: true, confirmedPaneIds })
          })()
        }}
        onCancel={cancelClose}
      />
    )
  })()

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`statusbar-resource${open ? ' is-open' : ''}`}
        data-statusbar-resource
        aria-haspopup="dialog"
        aria-expanded={open}
        title={segmentTooltip(snapshot)}
        onMouseDown={() => {
          // 버튼이 포커스를 가져가기 전 자리 — 패널을 닫으면 여기로 돌아간다(키보드로 열면 버튼 자신).
          if (!open) returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onKeyDown={(event) => {
          if (!open && (event.key === 'Enter' || event.key === ' ')) returnFocusRef.current = buttonRef.current
        }}
        onClick={toggle}
      >
        {segmentLabel(snapshot)}
      </button>
      {panel === null ? null : createPortal(panel, document.body)}
      {confirm === null ? null : createPortal(confirm, document.body)}
    </>
  )
}
