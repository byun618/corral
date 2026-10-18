// 상태바 Resource Manager 세그먼트 (LIFE-637) — 기존 JS 힙 표시 자리에 들어가는 자기 완결 요소(자기 상태·IPC 구독·패널).
//
// 세그먼트: `CPU n% · 메모리 x.x GB`(표시 규칙 `resource-view.ts`). 클릭하면 패널.
// 패널(R4): 시스템 한 줄 · 앱·herdr 행 · worktree 묶음(합계 + pane 행). 열린 동안 main 푸시로 갱신. Esc·바깥 클릭으로 닫히고
// 열기 전 포커스로 돌아간다. ↑↓·Home·End 로 pane 행 이동, Enter = 이동, Delete = 닫기.
// 행 동작(R5): 이동 = 기존 revealPane 길 · 닫기 = 기존 실행 중 확인 게이트(main `closeTabsGated`) + 기존 확인 창(`ConfirmClose`).
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ResourcePaneRow, ResourceSnapshot } from '../../../shared/resource.js'
import type { RunningPane } from '../../../shared/types.js'
import { CLOSE_SKIP_FAILED_NOTICE, closeCopy } from '../close-copy.js'
import { formatCpu, formatMemory, groupPanes, hostLine, measureCells, RESOURCE_EMPTY, segmentLabel, segmentTooltip, type ResourceSortKey } from '../resource-view.js'
import { updateSettings } from '../settings-store.js'
import { ConfirmClose } from './ConfirmClose.js'
import './resource.css'

type PendingClose = { row: ResourcePaneRow; running: RunningPane[] }

const ROW_SELECTOR = '[data-statusbar-resource-row]'

export function ResourceSegment(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [sort, setSort] = useState<ResourceSortKey>('memory')
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  const [error, setError] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

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

  const closePanel = useCallback((input: { restoreFocus: boolean }) => {
    setOpen(false)
    setPendingClose(null)
    setError(null)
    if (!input.restoreFocus) return
    const target = returnFocusRef.current
    if (target !== null && target.isConnected) target.focus()
    else buttonRef.current?.focus()
  }, [])

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
    const panel = panelRef.current
    if (panel === null) return
    const first = panel.querySelector<HTMLElement>(ROW_SELECTOR) ?? panel
    first.focus()
  }, [open])

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

  const requestClose = async (input: { row: ResourcePaneRow; confirmed: boolean; confirmedPaneIds: string[] }): Promise<void> => {
    const result = await window.corral.closeResourcePane({ paneId: input.row.paneId, confirmed: input.confirmed, confirmedPaneIds: input.confirmedPaneIds })
    switch (result.outcome) {
      case 'closed':
        setPendingClose(null)
        setError(null)
        return
      case 'needs-confirm':
        setPendingClose({ row: input.row, running: result.running })
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

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (pendingClose !== null) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closePanel({ restoreFocus: true })
      return
    }
    const panel = panelRef.current
    if (panel === null) return
    const rows = [...panel.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
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
          <div className="statusbar-resource-line" data-statusbar-resource-herdr title={herdrCells?.title ?? undefined}>
            <span className="statusbar-resource-name">herdr 서버</span>
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
                      onClick={() => reveal(row)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Delete' && event.key !== 'Backspace') return
                        event.preventDefault()
                        void requestClose({ row, confirmed: false, confirmedPaneIds: [] })
                      }}
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
                      onClick={() => void requestClose({ row, confirmed: false, confirmedPaneIds: [] })}
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
    const { row, running } = pendingClose
    const copy = closeCopy({ kind: 'tabs', tabCount: 1, running, agentPaneIds: new Set(row.agent === null ? [] : [row.paneId]), pinnedCount: 0 })
    const confirmedPaneIds = running.map((pane) => pane.paneId)
    return (
      <ConfirmClose
        key={`${row.paneId}|${confirmedPaneIds.join(',')}`}
        copy={copy}
        rows={[{ key: row.paneId, label: row.title, foreground: running.flatMap((pane) => pane.foreground) }]}
        onConfirm={({ dontAskAgain }) => {
          void (async () => {
            // 기존 탭 닫기와 같다 — 체크 + 확인만 저장하고, 저장이 실패해도 사용자가 확인한 닫기는 진행한다.
            if (dontAskAgain && copy.dontAskAgain !== null && !(await updateSettings(copy.dontAskAgain.patch))) setError(CLOSE_SKIP_FAILED_NOTICE)
            await requestClose({ row, confirmed: true, confirmedPaneIds })
          })()
        }}
        onCancel={() => setPendingClose(null)}
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
