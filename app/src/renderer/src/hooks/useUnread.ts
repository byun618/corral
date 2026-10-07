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
import type { AppState, PaneRow, UiPrefs } from '../../../shared/types.js'
import { acknowledgeInput, EMPTY_UNREAD, ingest, markRead, markUnread, type PaneObservation, type UnreadModel, type Watched } from '../unread.js'

function readAttention(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** main 이 transcript 를 읽는 provider (`shared/types.ts` `TranscriptAgent`). */
const TRANSCRIPT_AGENTS: readonly string[] = ['claude', 'codex', 'grok']

/**
 * 발화로 기동 반짝임을 가를 수 있는 pane 인가 (LIFE-502) — transcript provider 이고, codex 면 통합이 깔려 있다.
 * codex 통합이 `not-installed` 면 세션 참조가 영영 안 와서 「참조 없음 = 아직 프롬프트 없음」 이 거짓이 된다 — 판단 불가로 두고 옛 동작(센다)을 따른다(r1 R1-02).
 */
export function judgeableOf(input: { agent: string | null; integrations: AppState['integrations'] }): boolean {
  if (input.agent === null || !TRANSCRIPT_AGENTS.includes(input.agent)) return false
  if (input.agent !== 'codex') return true
  return !input.integrations.some((row) => row.agent === 'codex' && row.state === 'not-installed')
}

/** 세션 참조의 열쇠 — 같은 참조인지 비교하는 데만 쓴다. */
function sessionKeyOf(pane: Pick<PaneRow, 'agentSession'>): string | null {
  if (pane.agentSession === null) return null
  return pane.agentSession.kind === 'id' ? pane.agentSession.id : pane.agentSession.path
}

/**
 * transcript 지문에 사람 발화가 있나 — 있으면 `true`. 없을 때 지문을 **못 읽은** 것(참조의 파일을 못 찾음·못 읽음·모양이 낯섦)이면
 * 「발화 없음」 이 아니라 모름이다 → `null`(판단 불가 = 옛 동작, r2 R2-01). 발화가 보이면 활동 상태와 무관하게 `true` 다.
 */
function promptSeenOf(digest: PaneRow['digest']): boolean | null {
  if (digest.firstPrompt !== null || digest.lastPrompt !== null) return true
  switch (digest.activity.state) {
    case 'unresolved':
    case 'unreadable':
    case 'unknown-format':
      return null
    case 'none':
    case 'text':
      return false
  }
}

/** `observationsOf` 가 읽는 칸만 — 테스트가 상태 전체를 만들지 않아도 되게. */
type ObservedPane = Pick<PaneRow, 'paneId' | 'agentStatus' | 'agentState' | 'agent' | 'agentSession' | 'digest'>
type ObservedState = {
  repos: readonly { worktrees: readonly { path: string; workspace: { tabs: readonly { panes: readonly ObservedPane[] }[] } | null }[] }[]
  integrations: AppState['integrations']
}

/** 상태 묶음 → 관측 목록. 모든 열린 pane(셸 pane 도 — 보고로 에이전트가 붙으면 완료가 선다). */
export function observationsOf(state: ObservedState): PaneObservation[] {
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
            history: pane.agentState.history.map((step) => ({ status: step.status, enteredAt: step.observedAt })),
            agent: pane.agent,
            sessionKey: sessionKeyOf(pane),
            promptSeen: promptSeenOf(pane.digest),
            judgeable: judgeableOf({ agent: pane.agent, integrations: state.integrations }),
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
    const repos = state.repos.map((repo) => ({ root: repo.root, error: repo.error !== null, worktreePaths: repo.worktrees.map((row) => row.path) }))
    const retainedPaneIds = new Set(state.retainedAgents.map((row) => row.paneId))
    setModel((prev) => ingest(prev, { panes: observationsOf(state), retainedPaneIds, repos, activeWorktree, attentive, watched }))
  }, [state, activeWorktree, attentive, watched])

  // 벨 영속 — 첫 읽기 전에는 쓰지 않는다(빈 집합으로 저장된 벨을 덮지 않게). 읽은 벨은 그사이 완료가 켠 벨과 합친다.
  // 읽기가 실패하면 이번 실행 동안 저장하지 않는다(r1 L2ⓐ — 저장값을 모르는 채 덮어쓰지 않게).
  // 읽기 전에 누른 Mark Read/Unread 는 합친 **뒤에** 누른 순서대로 다시 적용한다(r1 L2ⓑ — 읽음 처리한 벨이 합집합으로 되살아나지 않게).
  const hydrated = useRef(false)
  const written = useRef<string | null>(null)
  // 읽기 전의 Mark 기록. `null` = 더 모으지 않는다 — 읽기가 끝났다(성공이면 다시 적용한 뒤, 재시도까지 실패면 버린다 — r2 F-D · r3 L-5).
  const pending = useRef<Array<{ kind: 'read' | 'unread'; path: string }> | null>([])
  // 읽기가 재시도까지 실패했다 — 이번 실행은 저장하지 않는다. 저장 이펙트도 이것을 본다(r3 L-6: `hydrated` 와 함께 서도 저장 안 함).
  const failed = useRef(false)
  useEffect(() => {
    let cancelled = false
    // 읽기 실패는 한 번 다시 읽는다(r2 F-D).
    window.corral
      .getUiPrefs()
      .catch((error: unknown) => {
        console.warn('[unread] ui-prefs 읽기 실패 — 한 번 다시 읽는다', error)
        return window.corral.getUiPrefs()
      })
      .then((prefs: UiPrefs) => {
        if (cancelled) return
        const stored = Array.isArray(prefs.unreadWorktrees) ? prefs.unreadWorktrees : []
        written.current = JSON.stringify([...stored].sort())
        hydrated.current = true
        const replay = pending.current ?? []
        pending.current = null
        // 늘 새 집합 — 읽기 전에 켜진 벨이 있으면 아래 쓰기 이펙트가 합친 값을 쓴다.
        setModel((prev) => {
          let merged: UnreadModel = { ...prev, worktrees: new Set([...prev.worktrees, ...stored]) }
          for (const op of replay) merged = op.kind === 'read' ? markRead(merged, op.path) : markUnread(merged, op.path)
          return merged
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        failed.current = true
        pending.current = null
        console.warn('[unread] ui-prefs 다시 읽기도 실패 — 이번 실행 동안 벨을 저장하지 않는다', error)
      })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (!hydrated.current || failed.current) return
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

  const modelRef = useRef(model)
  modelRef.current = model
  const apply = useCallback((kind: 'read' | 'unread', path: string) => {
    pending.current?.push({ kind, path })
    setModel((prev) => (kind === 'read' ? markRead(prev, path) : markUnread(prev, path)))
  }, [])
  const read = useCallback((path: string) => apply('read', path), [apply])
  const unread = useCallback((path: string) => apply('unread', path), [apply])
  const toggle = useCallback((path: string) => apply(modelRef.current.worktrees.has(path) ? 'read' : 'unread', path), [apply])
  const panes = useMemo(() => new Set(model.panes.keys()), [model.panes])
  return { panes, worktrees: model.worktrees, markRead: read, markUnread: unread, toggle }
}
