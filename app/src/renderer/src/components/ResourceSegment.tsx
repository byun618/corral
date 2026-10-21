// 상태바 Resource Manager 세그먼트 (LIFE-637) — 기존 JS 힙 표시 자리에 들어가는 자기 완결 요소(자기 상태·IPC 구독·패널).
//
// 세그먼트: `CPU n% · 메모리 x.x GB`(표시 규칙 `resource-view.ts` — CPU 는 맥 전체 대비, 행은 코어당). 클릭하면 패널.
// 패널(R4): 시스템 한 줄 · 앱·herdr 행 · worktree 묶음(합계 + pane 행). 열린 동안 main 푸시로 값만 갱신하고 행 순서는 얼린다(J1 —
// 다시 매기는 때는 열 때·정렬을 바꿀 때뿐, 새 pane 은 묶음 끝에). Esc(패널 안 포커스, 또는 포커스가 body)·바깥 클릭으로
// 닫히고 열기 전 포커스로 돌아간다. 호스트(상태바)가 `inert` 가 되면(팔레트 등) 닫는다(J4 — 포털 패널은 inert 밖이다).
// ↑↓·Home·End 로 pane 행 이동, Enter = 이동. 포커스된 행이 사라지면 포커스는 이웃 행(없으면 패널)으로(F4), 남아 있으면 그 pane 으로.
// 닫기는 ✕ 버튼만(F8 — 한 키 닫기 없음).
// 행 동작(R5):
//   · 이동 = 기존 revealPane 길.
//   · 닫기 — split 탭의 pane: 기존 실행 중 확인 게이트(main `closeTabsGated`, pane 단위).
//            탭의 마지막 pane(클릭 순간의 main 위상, H3): 기존 탭 닫기 IPC(`closeTabs`) — 핀 확인(`confirmClosePinnedTab`) + 그 worktree 의 마지막 터미널 탭이면 수정 문서 확인(`confirmDiscardOrSave`)
//            을 사이드바·탭 닫기와 같은 규칙으로 먼저 지난다(F7).
//     확인 창은 기존 `ConfirmClose`, 문구는 pane 기준(`paneCloseCopy`). 뜨면 취소 버튼에 포커스, Esc = 취소(F3).
//     확인한 뒤 다시 부르기 전에 길을 다시 묻고, 바뀌었으면 처음부터 다시 진행한다(J2 — 확인 창에 머무는 동안 옆 pane 이 끝날 수 있다).
//     같은 행의 닫기가 진행 중이면 다음 ✕ 는 무시한다(J6). 방금 닫은 pane 의 ✕ 는 다음 스냅샷까지 무시한다(K6).
//     길을 묻는 동안(첫 조회·확인 뒤 재조회) 취소·Esc·패널 닫기가 오면 닫기를 부르지 않는다(K1 — 세대 번호).
//     확인 창이 떠 있는 동안 패널은 inert 이고 행 동작은 시작되지 않는다(K2).
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import type { RunningPane } from '../../../shared/types.js'
import type { ResourceCloseResult, ResourceCloseRoute, ResourcePaneRow, ResourceSnapshot } from '../../../shared/resource.js'
import { CLOSE_SKIP_FAILED_NOTICE } from '../close-copy.js'
import { allDocs } from '../file-docs.js'
import { confirmDiscardOrSave } from '../file-save.js'
import {
  formatCpu,
  groupPanes,
  groupTooltip,
  HERDR_ROW_LABEL,
  HERDR_ROW_TOOLTIP,
  hostLine,
  keepOrder,
  measureCells,
  memoryText,
  orderOf,
  paneCloseCopy,
  RESOURCE_EMPTY,
  RESOURCE_ROW_CPU_TOOLTIP,
  segmentLabel,
  segmentTooltip,
  type PanelOrder,
  type ResourceSortKey,
} from '../resource-view.js'
import { getSettings, updateSettings } from '../settings-store.js'
import { pinnedTabIds, readTabMarks } from '../tab-marks.js'
import { ConfirmClose } from './ConfirmClose.js'
import './resource.css'

/** 닫기 길 — split 탭의 pane 은 pane 게이트, 탭의 마지막 pane 은 기존 탭 닫기. */
type CloseTarget =
  | { kind: 'pane'; row: ResourcePaneRow }
  | { kind: 'tab'; row: ResourcePaneRow; tabId: string; lastInWorktree: boolean; pinned: boolean; alwaysConfirm: boolean }

type PendingClose = { target: CloseTarget; running: RunningPane[] }

const ROW_SELECTOR = '[data-statusbar-resource-row]'

/** 확인 뒤 다시 물은 길이 처음 정한 길과 같은가(J2). 탭 길은 같은 탭이고, 그 사이 마지막 터미널 탭이 되지 않았어야 한다(수정 문서 확인). */
function sameRoute(input: { target: CloseTarget; route: ResourceCloseRoute }): boolean {
  const { target, route } = input
  switch (route.kind) {
    case 'missing':
      return false
    case 'pane':
      return target.kind === 'pane'
    case 'tab':
      return target.kind === 'tab' && target.tabId === route.tabId && (target.lastInWorktree || !route.lastInWorktree)
  }
}

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
  /** 마지막으로 포커스가 있던 행의 pane 과 자리 — 그 행이 남아 있으면 그 pane 으로, 사라지면 같은 자리(이웃)로 포커스를 옮긴다(F4·J1). */
  const focusPaneRef = useRef<string | null>(null)
  const focusIndexRef = useRef(0)
  /** 열린 동안 얼린 행 순서(J1). 닫혀 있거나 정렬을 막 바꿨으면 null — 다음 렌더가 정렬 순서로 다시 매긴다. */
  const orderRef = useRef<PanelOrder | null>(null)
  /** 닫기가 진행 중인 pane(J6). */
  const closingRef = useRef(new Set<string>())
  /** 확인 창을 연 행 — 취소하면 그 행으로 포커스를 돌린다. */
  const closingPaneRef = useRef<string | null>(null)
  /** 취소·패널 닫기 세대(K1). 길을 묻는 await 뒤 세대가 바뀌었으면 그 닫기는 버린다 — 상태는 진행 중 함수에 낡은 값으로 남는다. */
  const closeGenRef = useRef(0)
  /** 방금 닫기에 성공한 pane(K6) — 다음 스냅샷이 오면 비운다. */
  const closedRef = useRef(new Set<string>())

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

  useEffect(() => {
    closedRef.current.clear()
  }, [snapshot])

  const rowsInPanel = (): HTMLElement[] => [...(panelRef.current?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? [])]
  /** 행(이동 버튼)이나 그 ✕ 에 포커스가 오면 그 pane 과 자리를 기록한다(K4 — ✕ 로 닫은 뒤에도 이웃으로). */
  const rememberFocus = (paneId: string): void => {
    focusPaneRef.current = paneId
    focusIndexRef.current = Math.max(0, rowsInPanel().findIndex((row) => row.dataset.statusbarResourceRow === paneId))
  }

  const focusRowNear = useCallback((input: { paneId: string | null }) => {
    const panel = panelRef.current
    if (panel === null) return
    const rows = [...panel.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
    const same = input.paneId === null ? undefined : rows.find((row) => row.dataset.statusbarResourceRow === input.paneId)
    const target = same ?? rows[Math.min(focusIndexRef.current, rows.length - 1)] ?? panel
    target.focus()
  }, [])

  const closePanel = useCallback((input: { restoreFocus: boolean }) => {
    closeGenRef.current += 1
    setOpen(false)
    setPendingClose(null)
    setError(null)
    if (!input.restoreFocus) return
    const target = returnFocusRef.current
    if (target !== null && target.isConnected) target.focus()
    else buttonRef.current?.focus()
  }, [])

  const cancelClose = useCallback(() => {
    closeGenRef.current += 1
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
    focusPaneRef.current = null
    focusIndexRef.current = 0
    focusRowNear({ paneId: null })
  }, [open, focusRowNear])

  // 호스트가 inert 가 되면(팔레트·빠른 열기 — App 이 상태바에 건다) 패널을 닫는다(J4). 포커스는 그 UI 가 가져간다.
  const hostInert = (): boolean => buttonRef.current?.closest('[inert]') != null
  useEffect(() => {
    if (!open) return
    const check = (): void => {
      if (buttonRef.current?.closest('[inert]') != null) closePanel({ restoreFocus: false })
    }
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { attributes: true, attributeFilter: ['inert'], subtree: true })
    return () => observer.disconnect()
  }, [open, closePanel])

  // 확인 창이 뜨면 취소 버튼으로(F3 — Enter·Space 가 뒤의 행 「이동」 으로 새지 않는다).
  useEffect(() => {
    if (pendingClose === null) return
    document.querySelector<HTMLElement>('[data-close-confirm-cancel]')?.focus()
  }, [pendingClose])

  // 포커스된 행이 사라져 포커스가 body 로 떨어졌으면 이웃 행(없으면 패널)으로(F4).
  useEffect(() => {
    if (!open || pendingClose !== null) return
    const active = document.activeElement
    if (active === null || active === document.body) focusRowNear({ paneId: focusPaneRef.current })
  }, [open, pendingClose, snapshot, focusRowNear])

  const toggle = (): void => {
    if (open) {
      closePanel({ restoreFocus: true })
      return
    }
    setError(null)
    setOpen(true)
  }

  /** 행 동작을 시작하지 않는 때 — 호스트가 inert(J4) 이거나 확인 창이 떠 있다(K2). */
  const blocked = (): boolean => hostInert() || pendingClose !== null

  const reveal = (row: ResourcePaneRow): void => {
    if (blocked()) return
    // 패널은 곧 닫힌다 — 실패는 토스트로(K5: 열 때 지난 오류를 비우므로 패널 오류 칸에 남기지 않는다).
    void window.corral.revealResourcePane({ paneId: row.paneId }).then((ok) => {
      if (!ok) toast('그 pane 을 찾지 못했다')
    })
    // 이동하면 포커스는 그 pane 이 가져간다 — 열기 전 자리로 되돌리지 않는다.
    closePanel({ restoreFocus: false })
  }

  const runClose = async (input: { target: CloseTarget; confirmed: boolean; confirmedPaneIds: string[]; gen: number }): Promise<void> => {
    const { target } = input
    // 기다리는 사이 취소·Esc·패널 닫기(L1·L2) — 화면 상태도, 길 재시작도 건드리지 않는다.
    const stale = (): boolean => input.gen !== closeGenRef.current
    let result: ResourceCloseResult
    try {
      result = target.kind === 'tab'
        ? await window.corral.closeTabs({ tabIds: [target.tabId], confirmed: input.confirmed, alwaysConfirm: target.alwaysConfirm, confirmedPaneIds: input.confirmedPaneIds })
        : await window.corral.closeResourcePane({ paneId: target.row.paneId, confirmed: input.confirmed, confirmedPaneIds: input.confirmedPaneIds })
    } catch (failure) {
      if (stale()) return
      setPendingClose(null)
      setError(`닫지 못했다: ${failure instanceof Error ? failure.message : String(failure)}`)
      return
    }
    if (result.outcome !== 'closed' && stale()) return
    switch (result.outcome) {
      case 'closed': {
        // 닫은 목록에 대상이 없으면 아무것도 닫히지 않았다(F6 — 그 사이 사라졌다) — 성공으로 보이지 않는다.
        const id = target.kind === 'tab' ? target.tabId : target.row.paneId
        const closed = result.closed.includes(id)
        // main 에서 실제로 닫혔다는 사실이라 세대와 상관없이 남긴다(K6).
        if (closed) closedRef.current.add(target.row.paneId)
        if (stale()) return
        setPendingClose(null)
        setError(closed ? null : '닫힌 것이 없다 — 이미 없어졌을 수 있다')
        return
      }
      case 'needs-confirm':
        setPendingClose({ target, running: result.running })
        return
      case 'route-changed':
        // main 이 pane 게이트를 거절했다(J2) — 지금 위상으로 처음부터.
        setPendingClose(null)
        await startClose(target.row)
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

  /** 길은 지금의 위상으로 main 에 묻는다(H3 — 스냅샷은 최대 2초 낡았다: split 직후·옆 pane 소멸 직후). 실패면 null(오류 표시). */
  const askRoute = async (paneId: string): Promise<ResourceCloseRoute | null> => {
    try {
      return await window.corral.getResourceCloseRoute({ paneId })
    } catch (failure) {
      setError(`닫지 못했다: ${failure instanceof Error ? failure.message : String(failure)}`)
      return null
    }
  }

  const startClose = async (row: ResourcePaneRow): Promise<void> => {
    const gen = closeGenRef.current
    closingPaneRef.current = row.paneId
    setError(null)
    const route = await askRoute(row.paneId)
    if (route === null || gen !== closeGenRef.current) return
    await proceedClose({ row, route, gen })
  }

  const proceedClose = async (input: { row: ResourcePaneRow; route: ResourceCloseRoute; gen: number }): Promise<void> => {
    const { row, route } = input
    switch (route.kind) {
      case 'missing':
        setError('그 pane 이 없다(이미 닫혔다)')
        return
      case 'pane':
        await runClose({ target: { kind: 'pane', row }, confirmed: false, confirmedPaneIds: [], gen: input.gen })
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
        if (input.gen !== closeGenRef.current) return
        await runClose({
          target: { kind: 'tab', row, tabId: route.tabId, lastInWorktree: route.lastInWorktree, pinned, alwaysConfirm: getSettings().confirmClosePinnedTab && pinned },
          confirmed: false,
          confirmedPaneIds: [],
          gen: input.gen,
        })
        return
      }
    }
  }

  /** ✕ 한 번 = 닫기 한 번(J6). 진행 중인 행의 다음 클릭은 IPC 없이 무시한다. 확인 창의 「확인」 도 같은 가드를 지난다. */
  const guarded = async (input: { paneId: string; run: () => Promise<void> }): Promise<void> => {
    const closing = closingRef.current
    if (closing.has(input.paneId)) return
    closing.add(input.paneId)
    try {
      await input.run()
    } finally {
      closing.delete(input.paneId)
    }
  }

  /** 확인 창의 「확인」 — 다시 부르기 전에 길을 다시 묻는다(J2). 같으면 확인한 대로, 바뀌었으면 지금 위상으로 처음부터. */
  const confirmClose = async (input: { target: CloseTarget; confirmedPaneIds: string[]; dontAskAgainPatch: Parameters<typeof updateSettings>[0] | null }): Promise<void> => {
    const { target } = input
    const gen = closeGenRef.current
    const route = await askRoute(target.row.paneId)
    // 묻는 사이 취소·Esc·패널 닫기(K1) — 확인 창은 이미 내려갔다.
    if (gen !== closeGenRef.current) return
    if (route === null) {
      setPendingClose(null)
      return
    }
    if (!sameRoute({ target, route })) {
      setPendingClose(null)
      await proceedClose({ row: target.row, route, gen })
      return
    }
    // 기존 탭 닫기와 같다 — 체크 + 확인만 저장하고, 저장이 실패해도 사용자가 확인한 닫기는 진행한다.
    if (input.dontAskAgainPatch !== null && !(await updateSettings(input.dontAskAgainPatch))) toast(CLOSE_SKIP_FAILED_NOTICE)
    if (gen !== closeGenRef.current) return
    await runClose({ target, confirmed: true, confirmedPaneIds: input.confirmedPaneIds, gen })
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

  const sorted = snapshot === null ? [] : groupPanes({ panes: snapshot.panes, sort })
  const groups = open && orderRef.current !== null ? keepOrder({ groups: sorted, order: orderRef.current }) : sorted
  // 이번에 보인 순서가 다음 푸시의 얼린 순서다(J1). 닫히면 버린다 — 다시 열면 그때의 정렬 순서.
  useEffect(() => {
    orderRef.current = open ? orderOf(groups) : null
  })
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
      inert={pendingClose !== null}
      onKeyDown={onPanelKeyDown}
    >
      <div className="statusbar-resource-head">
        <span className="statusbar-resource-title" title={segmentTooltip(snapshot)}>{segmentLabel(snapshot)}</span>
        <span className="statusbar-resource-sort" role="group" aria-label="정렬">
          {(['memory', 'cpu'] satisfies ResourceSortKey[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`statusbar-resource-sort-btn${sort === key ? ' is-active' : ''}`}
              data-statusbar-resource-sort={key}
              aria-pressed={sort === key}
              onClick={() => {
                // 이미 그 정렬이면 아무것도 바꾸지 않는다(K3 — 얼린 순서를 풀면 다음 푸시에서 행이 건너뛴다).
                if (key === sort || blocked()) return
                orderRef.current = null
                setSort(key)
              }}
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
            <span className="statusbar-resource-cpu" data-statusbar-resource-cpu title={RESOURCE_ROW_CPU_TOOLTIP}>{appCells?.cpu}</span>
            <span className="statusbar-resource-mem" data-statusbar-resource-memory>{appCells?.memory}</span>
          </div>
          <div className="statusbar-resource-line" data-statusbar-resource-herdr title={herdrTitle}>
            <span className="statusbar-resource-name">{HERDR_ROW_LABEL}</span>
            <span className="statusbar-resource-cpu" data-statusbar-resource-cpu title={RESOURCE_ROW_CPU_TOOLTIP}>{herdrCells?.cpu}</span>
            <span className="statusbar-resource-mem" data-statusbar-resource-memory>{herdrCells?.memory}</span>
          </div>
          {groups.length === 0 ? <div className="statusbar-resource-note">열린 pane 이 없다</div> : null}
          {groups.map((group) => (
            <div key={group.key} className="statusbar-resource-group" data-statusbar-resource-group={group.key}>
              <div className="statusbar-resource-line statusbar-resource-group-head" title={groupTooltip(group) ?? undefined}>
                <span className="statusbar-resource-name">{group.label}</span>
                <span className="statusbar-resource-cpu" data-statusbar-resource-cpu title={RESOURCE_ROW_CPU_TOOLTIP}>{group.usage === null ? RESOURCE_EMPTY : formatCpu(group.usage.cpu)}</span>
                <span className="statusbar-resource-mem" data-statusbar-resource-memory>{group.usage === null ? RESOURCE_EMPTY : memoryText(group.usage.memory)}</span>
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
                      onFocus={() => rememberFocus(row.paneId)}
                      onClick={() => reveal(row)}
                    >
                      <span className="statusbar-resource-name">{row.title}</span>
                      <span className="statusbar-resource-agent" data-statusbar-resource-agent>{row.agent ?? 'shell'}</span>
                      <span className="statusbar-resource-cpu" data-statusbar-resource-cpu title={RESOURCE_ROW_CPU_TOOLTIP}>{cells.cpu}</span>
                      <span className="statusbar-resource-mem" data-statusbar-resource-memory>{cells.memory}</span>
                    </button>
                    <button
                      type="button"
                      className="statusbar-resource-close"
                      data-statusbar-resource-close={row.paneId}
                      aria-label={`${row.title} 닫기`}
                      title="닫기"
                      onFocus={() => rememberFocus(row.paneId)}
                      onClick={() => {
                        if (blocked() || closedRef.current.has(row.paneId)) return
                        void guarded({ paneId: row.paneId, run: () => startClose(row) })
                      }}
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
          const dontAskAgainPatch = dontAskAgain && copy.dontAskAgain !== null ? copy.dontAskAgain.patch : null
          void guarded({ paneId: row.paneId, run: () => confirmClose({ target, confirmedPaneIds, dontAskAgainPatch }) })
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
