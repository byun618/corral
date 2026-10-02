// 안 읽음 장부의 화면 쪽 (LIFE-471 S5) — 창 신호 · 상태 묶음 공급 · 벨 영속 · 터미널 입력 확인. 판정 자체는 `unread.ts`(순수).
//
// # 창 신호의 출처 (K1ⓐ) — renderer `document.visibilityState` + `document.hasFocus()`
//
// 198 과 같은 자리·같은 두 값이다(`terminal-notification-pane-visibility.ts:10-32`, `useAutoAckViewedAgent.ts:266`). main 의
// BrowserWindow 이벤트를 새 IPC 로 나르지 않는 이유: 판정에 쓰는 선택 pane·완료 묶음이 전부 렌더러에 있고, Chromium 이 창
// 숨김·최소화·가림을 `visibilityState` 로, 앱 비활성화를 `hasFocus()`·`blur` 로 이미 알려 준다. 듣는 이벤트 =
// `visibilitychange` · window `focus` · window `blur`. 지금 값은 `<html data-window-attention>` 에 싣는다(격리 실행이 읽는 자리).
//
// G8: 이 훅은 herdr 를 부르지 않는다 — 확인은 corral 의 장부일 뿐 `pane.focus`·`tab.focus` 를 늘리거나 줄이지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, UiPrefs } from '../../../shared/types.js'
import { acknowledgeInput, EMPTY_UNREAD, ingest, markRead, markUnread, type PaneObservation, type UnreadModel, type Watched } from '../unread.js'

function readAttention(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** 상태 묶음 → 관측 목록. 모든 열린 pane(셸 pane 도 — 보고로 에이전트가 붙으면 완료가 선다). */
export function observationsOf(state: AppState): PaneObservation[] {
  const rows: PaneObservation[] = []
  for (const repo of state.repos)
    for (const worktree of repo.worktrees)
      for (const tab of worktree.workspace?.tabs ?? [])
        for (const pane of tab.panes)
          rows.push({
            paneId: pane.paneId,
            worktreePath: worktree.path,
            status: pane.agentStatus,
            enteredAt: pane.agentState.observedAt,
            previousStatus: pane.agentState.history[0]?.status ?? null,
          })
  return rows
}

/** 터미널 입력으로 치는 키인가 (198 `terminal-keydown-fit.ts:20-70`) — 수식키 단독·자동 반복·⌘ 조합(앱 단축키·복사)은 아니다. */
export function isTerminalInputKey(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'metaKey'>): boolean {
  if (event.repeat || event.metaKey) return false
  return !['Alt', 'AltGraph', 'Control', 'Meta', 'Shift', 'CapsLock'].includes(event.key)
}

export type UnreadView = {
  /** 확인 안 된 완료가 있는 pane — 행 굵기·행 점·카드 상태 칸. */
  panes: ReadonlySet<string>
  /** 벨 켜진 worktree 경로. */
  worktrees: ReadonlySet<string>
  markRead: (path: string) => void
  markUnread: (path: string) => void
  /** 벨 클릭 — Mark Read/Mark Unread 와 같은 동작(K5ⓑ). */
  toggle: (path: string) => void
}

export function useUnread(input: {
  state: AppState | null
  /** 활성 영역의 선택 pane(창 상태와 무관) — 창이 보이고 포커스면 이것이 「보고 있는」 pane 이다. */
  viewedPaneId: string | null
  /** 활성 worktree 경로. */
  activeWorktree: string | null
}): UnreadView {
  const [attentive, setAttentive] = useState(readAttention)
  useEffect(() => {
    const update = (): void => setAttentive(readAttention())
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    // 첫 렌더(초기값)와 리스너 등록 사이에 온 focus 를 놓치지 않게 붙인 직후 한 번 다시 읽는다(격리 run3 — 기동 직후 앞 창인데 away 로 남았다).
    update()
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])
  useEffect(() => {
    document.documentElement.dataset['windowAttention'] = attentive ? 'watched' : 'away'
  }, [attentive])

  // 보고 있는 pane 과 그 시작 시각 — pane 이나 창 상태가 바뀔 때만 시각이 움직인다.
  const target = attentive ? input.viewedPaneId : null
  const watchRef = useRef<Watched>(null)
  if ((watchRef.current?.paneId ?? null) !== target) watchRef.current = target === null ? null : { paneId: target, since: Date.now() }
  const watched = watchRef.current

  const [model, setModel] = useState<UnreadModel>(EMPTY_UNREAD)
  const { state, activeWorktree } = input
  useEffect(() => {
    if (state === null) return
    const worktreePaths = new Set(state.repos.flatMap((repo) => repo.worktrees.map((row) => row.path)))
    const retainedPaneIds = new Set(state.retainedAgents.map((row) => row.paneId))
    setModel((prev) => ingest(prev, { panes: observationsOf(state), retainedPaneIds, worktreePaths, activeWorktree, attentive, watched }))
  }, [state, activeWorktree, attentive, watched])

  // 벨 영속 — 첫 읽기 전에는 쓰지 않는다(빈 집합으로 저장된 벨을 덮지 않게). 읽은 벨은 그사이 켜진 벨과 합친다.
  const hydrated = useRef(false)
  const written = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    window.corral
      .getUiPrefs()
      .then((prefs: UiPrefs) => {
        if (cancelled) return
        const stored = Array.isArray(prefs.unreadWorktrees) ? prefs.unreadWorktrees : []
        written.current = JSON.stringify([...stored].sort())
        hydrated.current = true
        // 늘 새 집합 — 읽기 전에 켜진 벨이 있으면 아래 쓰기 이펙트가 합친 값을 쓴다.
        setModel((prev) => ({ ...prev, worktrees: new Set([...prev.worktrees, ...stored]) }))
      })
      .catch(() => {
        hydrated.current = true
      })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (!hydrated.current) return
    const next = JSON.stringify([...model.worktrees].sort())
    if (next === written.current) return
    written.current = next
    window.corral.setUiPrefs({ unreadWorktrees: [...model.worktrees].sort() })
  }, [model.worktrees])

  // 터미널 입력 확인 (198 `terminal-keydown-fit.ts`) — xterm 의 입력 textarea 에서 실제 입력이 될 키.
  const worktreeOfPane = useRef<(paneId: string) => string | null>(() => null)
  worktreeOfPane.current = (paneId) => {
    for (const repo of state?.repos ?? [])
      for (const worktree of repo.worktrees)
        for (const tab of worktree.workspace?.tabs ?? []) if (tab.panes.some((pane) => pane.paneId === paneId)) return worktree.path
    return null
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isTerminalInputKey(event)) return
      if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('xterm-helper-textarea')) return
      const paneId = event.target.closest('[data-term-pane]')?.getAttribute('data-term-pane') ?? null
      if (paneId === null) return
      const worktreePath = worktreeOfPane.current(paneId)
      if (worktreePath !== null) setModel((prev) => acknowledgeInput(prev, { paneId, worktreePath }))
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const read = useCallback((path: string) => setModel((prev) => markRead(prev, path)), [])
  const unread = useCallback((path: string) => setModel((prev) => markUnread(prev, path)), [])
  const toggle = useCallback((path: string) => setModel((prev) => (prev.worktrees.has(path) ? markRead(prev, path) : markUnread(prev, path))), [])
  const panes = useMemo(() => new Set(model.panes.keys()), [model.panes])
  return { panes, worktrees: model.worktrees, markRead: read, markUnread: unread, toggle }
}
